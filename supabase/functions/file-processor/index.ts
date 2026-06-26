// CONNECTOR SEAM: This function converts the binary files Epic 04 stored metadata-only
// (content_status='needs_processing') into text/markdown, ENTIRELY IN-BOUNDARY. File bytes are
// fetched from Drive with the account's Vault refresh token (service role) and converted inside
// this function with bundled JS/WASM libs (unpdf, fflate, xlsx). NO content ever leaves the
// boundary — no external API or model (Rule 8). Scanned/image-only PDFs are marked needs_ocr for
// a future OCR worker.
//
// All job-state writes go through the advisory-/lease-guarded RPCs claim_processing_jobs /
// complete_processing_job — NEVER a direct .from('processing_jobs').update() — and complete
// derives the document from the job and rechecks lifecycle + content version before writing.
//
// NEVER log file names or file content. Errors carry fixed codes only (Rule: no PII in logs).
//
// Pure helpers (classifyConversion, extractDocxText, isLikelyScanned, truncateUtf8,
// zipWithinLimits) are also kept in src/lib/file-processing.ts and unit-tested under Jest; the
// logic is duplicated inline here because edge functions cannot import from src/.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1'
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2'
import * as XLSX from 'https://esm.sh/xlsx@0.18.5'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'

const MAX_JOBS_PER_RUN = 3
const STALE_SECONDS = 600
const MAX_ATTEMPTS = 3
const MAX_FILE_BYTES = 10_000_000
const MAX_UNCOMPRESSED_BYTES = 50_000_000
const MAX_ZIP_ENTRIES = 2000
const MAX_MARKDOWN_BYTES = 1_000_000
const MAX_PDF_PAGES = 200
const MAX_XLSX_CELLS = 200_000
const RUN_DEADLINE_MS = 50_000

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ---- Pure helpers (mirrors src/lib/file-processing.ts) ----

type ConversionKind = 'pdf' | 'docx' | 'xlsx' | 'unsupported'

function classifyConversion(mimeType: string): ConversionKind {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === DOCX_MIME) return 'docx'
  if (mimeType === XLSX_MIME) return 'xlsx'
  return 'unsupported'
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractDocxText(documentXml: string): string {
  if (!documentXml) return ''
  const paragraphs = documentXml.split(/<\/w:p>/i)
  const lines: string[] = []
  const runRe = /<(?:w:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:)?t>/gi
  for (const para of paragraphs) {
    let text = ''
    let m: RegExpExecArray | null
    while ((m = runRe.exec(para)) !== null) {
      text += decodeXmlEntities(m[1])
    }
    if (text.length > 0) lines.push(text)
  }
  return lines.join('\n')
}

function isLikelyScanned(pdfText: string): boolean {
  return pdfText.trim().length === 0
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

interface ZipEntryInfo { uncompressedBytes: number }
interface ZipLimits { maxEntries: number; maxUncompressedBytes: number }

function zipWithinLimits(entries: ZipEntryInfo[], limits: ZipLimits): boolean {
  if (entries.length > limits.maxEntries) return false
  let total = 0
  for (const e of entries) {
    total += e.uncompressedBytes
    if (total > limits.maxUncompressedBytes) return false
  }
  return true
}

// ---- Google token refresh (mirrors google-drive-collector) ----

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error('token_refresh_failed'), {
      tokenError: (err as Record<string, string>).error,
    })
  }
  const data = await res.json() as { access_token: string }
  return data.access_token
}

// ---- Bounded binary download (Codex v1 #7) ----
// Streams the file body, aborting once the accumulated byte count exceeds maxBytes. NEVER trusts
// Content-Length and NEVER silently truncates a binary (truncation would corrupt a zip/pdf), so
// an over-cap file throws 'file_too_large' rather than producing garbage.
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

async function readBytesBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('file_too_large')
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('file_too_large')
    }
    chunks.push(value)
  }
  return concat(chunks, total)
}

// ---- Conversion outcome ----

type Outcome = 'extracted' | 'needs_ocr' | 'skipped' | 'retry'
interface ConversionResult { outcome: Outcome; text: string | null; error: string | null }

async function convertPdf(bytes: Uint8Array): Promise<ConversionResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(bytes)
  } catch {
    // unpdf/pdf.js failed to even parse — transient/parser issue, NOT a scanned-doc signal.
    // Mark retry with a distinct code; never mislabel as needs_ocr (Codex v1 #13).
    return { outcome: 'retry', text: null, error: 'pdf_parser_unavailable' }
  }
  const pageCount = Math.min(pdf.numPages ?? 0, MAX_PDF_PAGES)
  let text: string
  try {
    const result = await extractText(pdf, { mergePages: true })
    text = Array.isArray(result.text) ? result.text.slice(0, pageCount).join('\n') : String(result.text ?? '')
  } catch {
    return { outcome: 'retry', text: null, error: 'pdf_parser_unavailable' }
  }
  if (isLikelyScanned(text)) {
    return { outcome: 'needs_ocr', text: null, error: null }
  }
  return { outcome: 'extracted', text: truncateUtf8(text, MAX_MARKDOWN_BYTES), error: null }
}

// Inspect a zip's central-directory metadata WITHOUT decompressing anything. fflate's filter is
// called once per entry with the uncompressed `originalSize`; returning false skips decompression.
// This lets us enforce entry-count / uncompressed-size caps BEFORE any decompression (code review
// v1 C2 — the old guard ran after unzipSync had already inflated the whole archive into memory).
function inspectZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const infos: ZipEntryInfo[] = []
  unzipSync(bytes, {
    filter: (f: { originalSize: number }) => {
      infos.push({ uncompressedBytes: f.originalSize })
      return false
    },
  })
  return infos
}

function convertDocx(bytes: Uint8Array): ConversionResult {
  let infos: ZipEntryInfo[]
  try {
    infos = inspectZipEntries(bytes)
  } catch {
    return { outcome: 'skipped', text: null, error: 'docx_unzip_failed' }
  }
  if (!zipWithinLimits(infos, { maxEntries: MAX_ZIP_ENTRIES, maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES })) {
    return { outcome: 'skipped', text: null, error: 'zip_bomb_guard' }
  }
  // Decompress ONLY word/document.xml (not the whole archive).
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, { filter: (f: { name: string }) => f.name === 'word/document.xml' })
  } catch {
    return { outcome: 'skipped', text: null, error: 'docx_unzip_failed' }
  }
  const docXml = entries['word/document.xml']
  if (!docXml) {
    return { outcome: 'skipped', text: null, error: 'docx_no_document_xml' }
  }
  const xml = strFromU8(docXml)
  const text = extractDocxText(xml)
  if (text.trim().length === 0) {
    return { outcome: 'skipped', text: null, error: 'docx_empty' }
  }
  return { outcome: 'extracted', text: truncateUtf8(text, MAX_MARKDOWN_BYTES), error: null }
}

function convertXlsx(bytes: Uint8Array): ConversionResult {
  // Zip guard FIRST via the metadata-only inspection (code review v1 C2): gate entry count +
  // total uncompressed size BEFORE SheetJS decompresses the workbook.
  let infos: ZipEntryInfo[]
  try {
    infos = inspectZipEntries(bytes)
  } catch {
    return { outcome: 'skipped', text: null, error: 'xlsx_unzip_failed' }
  }
  if (!zipWithinLimits(infos, { maxEntries: MAX_ZIP_ENTRIES, maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES })) {
    return { outcome: 'skipped', text: null, error: 'zip_bomb_guard' }
  }

  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(bytes, { type: 'array' })
  } catch {
    return { outcome: 'skipped', text: null, error: 'xlsx_parse_failed' }
  }

  // Cell cap: sum the cell counts of every sheet's !ref range BEFORE materializing CSV (Codex v2 #4/#5).
  let totalCells = 0
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    const ref = sheet?.['!ref']
    if (!ref) continue
    const range = XLSX.utils.decode_range(ref)
    const rows = range.e.r - range.s.r + 1
    const cols = range.e.c - range.s.c + 1
    totalCells += Math.max(0, rows) * Math.max(0, cols)
    if (totalCells > MAX_XLSX_CELLS) {
      return { outcome: 'skipped', text: null, error: 'xlsx_too_many_cells' }
    }
  }

  // Build markdown sheet-by-sheet, stopping once MAX_MARKDOWN_BYTES is reached during generation
  // (byte-bounded during, not after).
  const encoder = new TextEncoder()
  const parts: string[] = []
  let bytesSoFar = 0
  let stopped = false
  for (const name of wb.SheetNames) {
    if (stopped) break
    const header = `## ${name}\n`
    const sheet = wb.Sheets[name]
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : ''
    const block = header + csv + '\n\n'
    const blockBytes = encoder.encode(block).length
    if (bytesSoFar + blockBytes > MAX_MARKDOWN_BYTES) {
      const remaining = MAX_MARKDOWN_BYTES - bytesSoFar
      if (remaining > 0) parts.push(truncateUtf8(block, remaining))
      stopped = true
      break
    }
    parts.push(block)
    bytesSoFar += blockBytes
  }

  const md = parts.join('')
  if (md.trim().length === 0) {
    return { outcome: 'skipped', text: null, error: 'xlsx_empty' }
  }
  return { outcome: 'extracted', text: truncateUtf8(md, MAX_MARKDOWN_BYTES), error: null }
}

interface ClaimedJob {
  job_id: string
  document_id: string
  user_id: string
  attempts: number
  claimed_at: string
  drive_file_id: string
  mime_type: string
  connected_account_id: string
  lifecycle_version: number
  drive_modified_time: string | null
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')!
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const startedAt = Date.now()
  let enqueued = 0
  let claimed = 0
  let extracted = 0
  let needs_ocr = 0
  let skipped = 0
  let retried = 0

  // 1. Producer: enqueue pending jobs for needs_processing documents.
  const { error: enqErr } = await supabaseAdmin.rpc('enqueue_processing_jobs')
  if (!enqErr) enqueued = 1 // RPC returns void; flag that the producer ran.

  // Cache the refreshed access token per connected account within this run.
  const tokenCache = new Map<string, string | null>()

  async function getToken(accountId: string): Promise<string | null> {
    if (tokenCache.has(accountId)) return tokenCache.get(accountId)!
    const { data: refreshToken } = await supabaseAdmin.rpc('get_vault_secret', { secret_name: accountId })
    if (!refreshToken) { tokenCache.set(accountId, null); return null }
    try {
      const access = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
      tokenCache.set(accountId, access)
      return access
    } catch {
      tokenCache.set(accountId, null)
      return null
    }
  }

  async function complete(job: ClaimedJob, r: ConversionResult): Promise<void> {
    await supabaseAdmin.rpc('complete_processing_job', {
      p_job_id: job.job_id,
      p_claimed_at: job.claimed_at,
      p_attempts: job.attempts,
      p_lifecycle_version: job.lifecycle_version,
      p_drive_modified_time: job.drive_modified_time,
      p_outcome: r.outcome,
      p_text: r.text,
      p_error: r.error,
      p_max_attempts: MAX_ATTEMPTS,
    })
    if (r.outcome === 'extracted') extracted++
    else if (r.outcome === 'needs_ocr') needs_ocr++
    else if (r.outcome === 'skipped') skipped++
    else if (r.outcome === 'retry') retried++
  }

  // Claim ONE job at a time, only while under the run deadline and the per-run cap (code review
  // v1 I5). This never leases a job we won't process — claiming upfront would burn an attempt on
  // unstarted jobs if the deadline tripped mid-batch. A single synchronous parser call cannot be
  // preempted in Deno; per-file CPU is bounded by the input caps.
  while (claimed < MAX_JOBS_PER_RUN && Date.now() - startedAt <= RUN_DEADLINE_MS) {
    const { data: jobsData, error: claimErr } = await supabaseAdmin.rpc('claim_processing_jobs', {
      p_limit: 1,
      p_stale_seconds: STALE_SECONDS,
      p_max_attempts: MAX_ATTEMPTS,
    })
    if (claimErr) break
    const batch = (jobsData ?? []) as ClaimedJob[]
    if (batch.length === 0) break // queue drained
    const job = batch[0]
    claimed++

    try {
      const accessToken = await getToken(job.connected_account_id)
      if (!accessToken) {
        await complete(job, { outcome: 'retry', text: null, error: 'no_token' })
        continue
      }

      const dlRes = await fetch(`${DRIVE_API}/files/${job.drive_file_id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!dlRes.ok) {
        await dlRes.body?.cancel()
        await complete(job, { outcome: 'retry', text: null, error: `download_failed_${dlRes.status}` })
        continue
      }

      let bytes: Uint8Array
      try {
        bytes = await readBytesBounded(dlRes, MAX_FILE_BYTES)
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'file_too_large') {
          await complete(job, { outcome: 'skipped', text: null, error: 'file_too_large' })
        } else {
          await complete(job, { outcome: 'retry', text: null, error: 'download_read_failed' })
        }
        continue
      }

      const kind = classifyConversion(job.mime_type)
      let result: ConversionResult
      if (kind === 'pdf') {
        result = await convertPdf(bytes)
      } else if (kind === 'docx') {
        result = convertDocx(bytes)
      } else if (kind === 'xlsx') {
        result = convertXlsx(bytes)
      } else {
        result = { outcome: 'skipped', text: null, error: 'unsupported_type' }
      }

      await complete(job, result)
    } catch {
      // Any unexpected/transient error → retry (complete caps it to skipped at max attempts).
      await complete(job, { outcome: 'retry', text: null, error: 'processing_error' })
    }
  }

  return Response.json({ enqueued, claimed, extracted, needs_ocr, skipped, retried })
})
