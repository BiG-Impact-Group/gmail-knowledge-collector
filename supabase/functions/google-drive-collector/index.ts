// CONNECTOR SEAM: This function collects files via the Google Drive API.
// Backfill uses the Files API; incremental uses the Changes API. Personal Drive only
// (corpora=user; no allDrives flags). All document writes go through the advisory-locked
// RPCs collect_account_documents / delete_account_documents / reset_account_documents —
// NEVER a direct .from('documents').upsert() — to close the purge/collection TOCTOU race.
//
// Pure helpers (classifyFile, readBounded, backoff, changes-page reducer, chunk) are also
// kept in src/lib/drive-collector.ts and unit-tested under Jest; the logic is duplicated
// inline here because edge functions cannot import from src/.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'

const DRIVE_PAGE_SIZE = 25
const MAX_PAGES_PER_RUN = 4
const RPC_DOC_BATCH = 5
const MAX_CONTENT_BYTES = 500_000
const UNCHANGED = '__unchanged__'

const WORKSPACE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

const NATIVE_TEXT_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'text/csv',
  'text/javascript', 'application/json', 'application/xml', 'text/xml',
])

const BINARY_PROCESSING_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
])

interface DriveFile {
  id?: string
  name?: string
  mimeType?: string
  webViewLink?: string
  size?: string
  modifiedTime?: string
  trashed?: boolean
}

interface DriveChange {
  fileId?: string
  removed?: boolean
  file?: DriveFile
}

interface ConnectedAccountRow {
  id: string
  user_id: string
  email_address: string
  sync_cursor: string | null
  backfill_complete: boolean
  backfill_page_token: string | null
  lifecycle_version: number
}

interface DocRow {
  user_id: string
  drive_file_id: string
  name: string
  mime_type: string
  web_view_link: string | null
  size_bytes: string | null
  drive_modified_time: string | null
  text_content: string | null
  content_status: string
}

type ClassifyAction = 'export_workspace' | 'download_text' | 'needs_processing' | 'needs_ocr' | 'skip'

function classifyFile(mimeType: string, sizeBytes: number | null): { action: ClassifyAction; exportMimeType?: string } {
  if (WORKSPACE_EXPORTS[mimeType]) {
    return { action: 'export_workspace', exportMimeType: WORKSPACE_EXPORTS[mimeType] }
  }
  if (NATIVE_TEXT_TYPES.has(mimeType)) {
    if (sizeBytes !== null && sizeBytes > MAX_CONTENT_BYTES) return { action: 'needs_processing' }
    return { action: 'download_text' }
  }
  if (BINARY_PROCESSING_TYPES.has(mimeType)) {
    return { action: 'needs_processing' }
  }
  return { action: 'skip' }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000)
}

function isRateLimitReason(reason: string | undefined): boolean {
  return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Bounded retry wrapper around a Drive fetch. Retries 429 and rate-limit-reason 403.
async function driveFetch(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.status !== 429 && res.status !== 403) return res
    if (res.status === 403) {
      // Only retry rate-limit 403s; clone so the caller can still read the body.
      let rateLimited = false
      try {
        const body = await res.clone().json() as { error?: { errors?: Array<{ reason?: string }> } }
        rateLimited = isRateLimitReason(body.error?.errors?.[0]?.reason)
      } catch {
        rateLimited = false
      }
      if (!rateLimited) return res
    }
    if (attempt >= maxRetries) return res
    await sleep(backoffMs(attempt))
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

async function readBounded(res: Response, maxBytes = MAX_CONTENT_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes * 10) {
    await res.body?.cancel()
    throw new Error('content_too_large')
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return new TextDecoder().decode(buf.subarray(0, maxBytes))
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - total
    const slice = value.length > remaining ? value.subarray(0, remaining) : value
    chunks.push(slice)
    total += slice.length
  }
  await reader.cancel()
  return new TextDecoder().decode(concat(chunks))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

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

// Extract text content for a single file. Throws on transient failure so the caller can
// persist the row as needs_processing rather than dropping it.
async function extractContent(
  accessToken: string,
  file: DriveFile,
  classification: { action: ClassifyAction; exportMimeType?: string },
): Promise<string> {
  const auth = { Authorization: `Bearer ${accessToken}` }
  if (classification.action === 'export_workspace') {
    const res = await driveFetch(
      `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent(classification.exportMimeType!)}`,
      { headers: auth },
    )
    if (!res.ok) throw new Error(`export_failed_${res.status}`)
    return readBounded(res)
  }
  // download_text
  const res = await driveFetch(`${DRIVE_API}/files/${file.id}?alt=media`, { headers: auth })
  if (!res.ok) throw new Error(`download_failed_${res.status}`)
  return readBounded(res)
}

// Build a doc row for a file, extracting text content where applicable. On any extraction
// failure (including content_too_large) the row is still produced with needs_processing so
// the file is never silently dropped while the cursor advances past it.
async function buildDocRow(accessToken: string, account: ConnectedAccountRow, file: DriveFile): Promise<DocRow | null> {
  if (!file.id || !file.name || !file.mimeType) return null
  const sizeBytes = file.size ? parseInt(file.size, 10) : null
  const classification = classifyFile(file.mimeType, sizeBytes)

  let textContent: string | null = null
  let contentStatus: string

  if (classification.action === 'export_workspace' || classification.action === 'download_text') {
    try {
      textContent = await extractContent(accessToken, file, classification)
      contentStatus = 'extracted'
    } catch {
      // Transient extraction failure or content_too_large — persist metadata so Epic 05
      // (or a later run) can retry; never drop the file.
      textContent = null
      contentStatus = 'needs_processing'
    }
  } else if (classification.action === 'needs_processing') {
    contentStatus = 'needs_processing'
  } else if (classification.action === 'needs_ocr') {
    contentStatus = 'needs_ocr'
  } else {
    contentStatus = 'skipped'
  }

  return {
    user_id: account.user_id,
    drive_file_id: file.id,
    name: file.name,
    mime_type: file.mimeType,
    web_view_link: file.webViewLink ?? null,
    size_bytes: file.size ? String(parseInt(file.size, 10)) : null,
    drive_modified_time: file.modifiedTime ?? null,
    text_content: textContent,
    content_status: contentStatus,
  }
}

// Persist a page's docs via collect_account_documents, splitting into RPC_DOC_BATCH-sized
// sub-batches. Only the FINAL sub-batch carries the real cursor/backfill advance; earlier
// sub-batches pass the unchanged sentinels. For an empty page, issues one cursor-only call so
// the cursor always advances. Returns true on success, false if any RPC errored.
async function persistPage(
  supabaseAdmin: ReturnType<typeof createClient>,
  accountId: string,
  docs: DocRow[],
  backfillComplete: boolean | null,
  backfillPageToken: string,
  syncCursor: string,
): Promise<boolean> {
  const batches = chunk(docs, RPC_DOC_BATCH)
  if (batches.length === 0) {
    // Empty / deletion-only page: still advance the cursor with an empty doc array.
    const { error } = await supabaseAdmin.rpc('collect_account_documents', {
      p_account_id: accountId,
      p_documents: [],
      p_backfill_complete: backfillComplete,
      p_backfill_page_token: backfillPageToken,
      p_sync_cursor: syncCursor,
    })
    return !error
  }
  for (let i = 0; i < batches.length; i++) {
    const isFinal = i === batches.length - 1
    const { error } = await supabaseAdmin.rpc('collect_account_documents', {
      p_account_id: accountId,
      p_documents: batches[i],
      p_backfill_complete: isFinal ? backfillComplete : null,
      p_backfill_page_token: isFinal ? backfillPageToken : UNCHANGED,
      p_sync_cursor: isFinal ? syncCursor : UNCHANGED,
    })
    if (error) return false // cursor not advanced; page retried next run (upserts idempotent)
  }
  return true
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

  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('connected_accounts')
    .select('id, user_id, email_address, sync_cursor, backfill_complete, backfill_page_token, lifecycle_version')
    .eq('status', 'active')
    .eq('provider', 'google_drive')

  if (accountsError) {
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const account of (accounts ?? []) as ConnectedAccountRow[]) {
    try {
      const { data: refreshToken } = await supabaseAdmin
        .rpc('get_vault_secret', { secret_name: account.id })

      if (!refreshToken) {
        console.error(`No vault secret for account ${account.id}`)
        errors++
        continue
      }

      let accessToken: string
      try {
        accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
      } catch (err: unknown) {
        const tokenErr = err as { tokenError?: string }
        if (tokenErr.tokenError === 'invalid_grant' || tokenErr.tokenError === 'token_revoked') {
          // Guard on status='active' AND the lifecycle_version read at the start of this run:
          // if a reconnect bumped the version (new token issued) or the user disconnected,
          // this stale failure must NOT mark the fresh/revoked account error.
          await supabaseAdmin
            .from('connected_accounts')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('id', account.id)
            .eq('status', 'active')
            .eq('lifecycle_version', account.lifecycle_version)
        }
        errors++
        continue
      }

      if (!account.backfill_complete) {
        // === BACKFILL PATH ===
        // Capture the Changes start token BEFORE page 1 so any file created/modified/deleted
        // during the multi-run backfill is replayed by the incremental Changes pass. Stash it
        // in sync_cursor (unused for incremental until backfill completes).
        if (account.sync_cursor === null) {
          const startRes = await driveFetch(`${DRIVE_API}/changes/startPageToken`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (!startRes.ok) { errors++; continue }
          const startData = await startRes.json() as { startPageToken?: string }
          if (!startData.startPageToken) { errors++; continue }
          // Persist the start token immediately (cursor-only write).
          const ok = await persistPage(supabaseAdmin, account.id, [], null, UNCHANGED, startData.startPageToken)
          if (!ok) { errors++; continue }
          account.sync_cursor = startData.startPageToken
        }

        let pageToken = account.backfill_page_token ?? undefined
        let pagesThisRun = 0
        let aborted = false

        while (pagesThisRun < MAX_PAGES_PER_RUN) {
          const params = new URLSearchParams({
            q: 'trashed=false',
            fields: 'nextPageToken,files(id,name,mimeType,webViewLink,size,modifiedTime)',
            pageSize: String(DRIVE_PAGE_SIZE),
            corpora: 'user',
          })
          if (pageToken) params.set('pageToken', pageToken)

          const res = await driveFetch(`${DRIVE_API}/files?${params}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })

          if (res.status === 400) {
            // Expired files.list page token — clear it and restart pagination next run.
            const ok = await persistPage(supabaseAdmin, account.id, [], null, '', UNCHANGED)
            if (!ok) errors++
            aborted = true
            break
          }
          if (!res.ok) { errors++; aborted = true; break }

          const listData = await res.json() as { files?: DriveFile[]; nextPageToken?: string }
          const files = listData.files ?? []

          const pageDocs: DocRow[] = []
          for (const file of files) {
            try {
              const row = await buildDocRow(accessToken, account, file)
              if (row) pageDocs.push(row)
            } catch {
              // Could not even build metadata row — skip and count.
              errors++
            }
          }

          if (listData.nextPageToken) {
            // More pages: advance backfill_page_token, leave sync_cursor (holds start token).
            const ok = await persistPage(supabaseAdmin, account.id, pageDocs, null, listData.nextPageToken, UNCHANGED)
            if (!ok) { errors++; aborted = true; break }
            processed += pageDocs.length
            pageToken = listData.nextPageToken
            pagesThisRun++
          } else {
            // Final page: backfill complete. Clear page token; sync_cursor already holds the
            // pre-backfill start token, so leave it unchanged.
            const ok = await persistPage(supabaseAdmin, account.id, pageDocs, true, '', UNCHANGED)
            if (!ok) { errors++; aborted = true; break }
            processed += pageDocs.length
            aborted = true // done; exit loop
            break
          }
        }

        if (aborted) continue

      } else {
        // === INCREMENTAL CHANGES API PATH ===
        let pageToken = account.sync_cursor ?? ''
        let pagesThisRun = 0

        while (true) {
          const params = new URLSearchParams({
            pageToken,
            fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,webViewLink,size,modifiedTime,trashed))',
            pageSize: String(DRIVE_PAGE_SIZE),
            includeRemoved: 'true',
          })

          const res = await driveFetch(`${DRIVE_API}/changes?${params}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })

          if (res.status === 410) {
            // Cursor unrecoverable and we may have missed deletions — full reset (locked).
            // If the reset RPC fails, count it and leave state untouched so the next run
            // retries (cursor is not advanced).
            const { error: resetErr } = await supabaseAdmin.rpc('reset_account_documents', { p_account_id: account.id })
            if (resetErr) errors++
            break
          }
          if (!res.ok) { errors++; break }

          const data = await res.json() as {
            changes?: DriveChange[]
            nextPageToken?: string
            newStartPageToken?: string
          }

          const removedIds: string[] = []
          const liveFiles: DriveFile[] = []
          for (const change of data.changes ?? []) {
            const isRemoved = change.removed === true || change.file?.trashed === true
            if (isRemoved) {
              if (change.fileId) removedIds.push(change.fileId)
              continue
            }
            if (change.file?.id) liveFiles.push(change.file)
          }

          if (removedIds.length > 0) {
            // Deletions must succeed before the cursor advances — otherwise a failed delete
            // would leave purged Drive files visible forever once the cursor moves past them.
            const { error: delErr } = await supabaseAdmin.rpc('delete_account_documents', {
              p_account_id: account.id,
              p_file_ids: removedIds,
            })
            if (delErr) { errors++; break }  // do NOT advance cursor; retry this page next run
          }

          const upsertDocs: DocRow[] = []
          for (const file of liveFiles) {
            try {
              const row = await buildDocRow(accessToken, account, file)
              if (row) upsertDocs.push(row)
            } catch {
              errors++
            }
          }

          if (data.nextPageToken) {
            const ok = await persistPage(supabaseAdmin, account.id, upsertDocs, null, UNCHANGED, data.nextPageToken)
            if (!ok) { errors++; break }
            processed += upsertDocs.length
            pageToken = data.nextPageToken
            pagesThisRun++
            if (pagesThisRun >= MAX_PAGES_PER_RUN) break
          } else {
            const terminal = data.newStartPageToken ?? pageToken
            const ok = await persistPage(supabaseAdmin, account.id, upsertDocs, null, UNCHANGED, terminal)
            if (!ok) { errors++; break }
            processed += upsertDocs.length
            break
          }
        }
      }

    } catch {
      errors++
    }
  }

  return Response.json({ processed, errors, accounts: accounts?.length ?? 0 })
})
