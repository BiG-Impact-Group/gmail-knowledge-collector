// CONNECTOR SEAM: This function embeds extracted document text ENTIRELY IN-BOUNDARY using the
// Supabase Edge Runtime built-in gte-small model (384-dim). NO content ever leaves the boundary —
// no external API or model (Rule 8). It reads documents.text_content (already extracted by Epic 05),
// chunks it, embeds each chunk, and stores vectors in `chunks` via the SECURITY DEFINER RPC
// complete_embedding_job. Embedding is best-effort: it NEVER mutates documents.
//
// All job-state writes go through the lease-guarded RPCs claim_embedding_jobs /
// complete_embedding_job — NEVER a direct .from('embedding_jobs').update() — and complete derives
// the document from the job and rechecks lifecycle + content version before writing chunks.
//
// NEVER log document text or file names. Errors carry fixed codes only (Rule: no PII in logs).
//
// The pure chunker (chunkText) is also kept in src/lib/chunking.ts and unit-tested under Jest; the
// logic is duplicated inline here because edge functions cannot import from src/.
//
// `Supabase.ai` is a runtime global in the Supabase Edge Runtime — it is NOT importable. Declared
// below so this file type-checks under tsc.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Supabase Edge Runtime global (not importable). Provides the in-boundary inference session.
declare const Supabase: {
  ai: { Session: new (model: string) => { run: (input: string, opts: Record<string, unknown>) => Promise<unknown> } }
}

const MAX_JOBS_PER_RUN = 2
const MAX_CHUNKS_PER_DOC = 50
const STALE_SECONDS = 600
const MAX_ATTEMPTS = 3
const RUN_DEADLINE_MS = 45_000
const CHUNK_TARGET_CHARS = 1500
const CHUNK_OVERLAP_CHARS = 200
const MAX_CONTENT_CHARS = 200_000
const EMBEDDING_DIM = 384

// ---- Pure helper (mirrors src/lib/chunking.ts) ----

interface ChunkOptions { targetChars: number; overlapChars: number; maxChunks: number }

function findBreak(text: string, start: number, hardEnd: number): number {
  const window = text.slice(start, hardEnd)
  const para = window.lastIndexOf('\n\n')
  if (para > 0) return start + para + 2
  const sentenceRe = /[.!?]\s/g
  let sentenceCut = -1
  let m: RegExpExecArray | null
  while ((m = sentenceRe.exec(window)) !== null) {
    sentenceCut = m.index + m[0].length
  }
  if (sentenceCut > 0) return start + sentenceCut
  const space = window.lastIndexOf(' ')
  const newline = window.lastIndexOf('\n')
  const ws = Math.max(space, newline)
  if (ws > 0) return start + ws + 1
  return hardEnd
}

function chunkText(text: string, opts: ChunkOptions): string[] {
  const { targetChars, overlapChars, maxChunks } = opts
  if (maxChunks <= 0 || targetChars <= 0) return []
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= targetChars) return [trimmed]
  const overlap = Math.max(0, Math.min(overlapChars, targetChars - 1))
  const chunks: string[] = []
  let start = 0
  const n = trimmed.length
  while (start < n && chunks.length < maxChunks) {
    const hardEnd = Math.min(start + targetChars, n)
    let end: number
    if (hardEnd >= n) {
      end = n
    } else {
      end = findBreak(trimmed, start, hardEnd)
      if (end <= start + overlap) end = hardEnd
    }
    const piece = trimmed.slice(start, end).trim()
    if (piece.length > 0) chunks.push(piece)
    if (end >= n) break
    start = end - overlap
  }
  return chunks
}

// ---- Claimed job shape (mirrors claim_embedding_jobs RETURNS) ----

interface ClaimedJob {
  job_id: string
  document_id: string
  user_id: string
  attempts: number
  claimed_at: string
  connected_account_id: string
  lifecycle_version: number
  drive_modified_time: string | null
}

interface ChunkPayload { chunk_index: number; content: string; embedding: number[] }

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')!
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const startedAt = Date.now()
  let enqueued = 0
  let claimed = 0
  let embedded_docs = 0
  let total_chunks = 0
  let retried = 0
  let complete_errors = 0

  // One in-boundary inference session per run.
  const model = new Supabase.ai.Session('gte-small')

  // 1. Producer: enqueue jobs for extracted docs + purge stale chunks (RPC returns void).
  const { error: enqErr } = await supabaseAdmin.rpc('enqueue_embedding_jobs')
  if (!enqErr) enqueued = 1

  async function complete(
    job: ClaimedJob,
    outcome: 'done' | 'retry',
    chunks: ChunkPayload[] | null,
    truncated: boolean,
    error: string | null,
  ): Promise<boolean> {
    const { error: rpcErr } = await supabaseAdmin.rpc('complete_embedding_job', {
      p_job_id: job.job_id,
      p_claimed_at: job.claimed_at,
      p_attempts: job.attempts,
      p_lifecycle_version: job.lifecycle_version,
      p_drive_modified_time: job.drive_modified_time,
      p_outcome: outcome,
      p_chunks: chunks ?? [],
      p_truncated: truncated,
      p_error: error,
      p_max_attempts: MAX_ATTEMPTS,
    })
    if (rpcErr) {
      // RPC failed (deadlock abort / transient DB error). Don't count as completed — the job stays
      // 'processing' and is reclaimed after STALE_SECONDS.
      complete_errors++
      return false
    }
    return true
  }

  // Claim ONE job at a time, only while under the run deadline and the per-run cap (mirrors
  // file-processor). Never leases a job we won't process.
  while (claimed < MAX_JOBS_PER_RUN && Date.now() - startedAt <= RUN_DEADLINE_MS) {
    const { data: jobsData, error: claimErr } = await supabaseAdmin.rpc('claim_embedding_jobs', {
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
      // Read the document text (service role). Never logged.
      const { data: doc, error: docErr } = await supabaseAdmin
        .from('documents')
        .select('text_content')
        .eq('id', job.document_id)
        .maybeSingle()
      if (docErr || !doc || !doc.text_content) {
        await complete(job, 'retry', null, false, 'no_text')
        retried++
        continue
      }

      const text = (doc.text_content as string).slice(0, MAX_CONTENT_CHARS)
      // Chunk with one extra slot so we can detect overflow: if the document produces more than
      // MAX_CHUNKS_PER_DOC chunks, drop the excess and flag truncated.
      const allPieces = chunkText(text, {
        targetChars: CHUNK_TARGET_CHARS,
        overlapChars: CHUNK_OVERLAP_CHARS,
        maxChunks: MAX_CHUNKS_PER_DOC + 1,
      })
      if (allPieces.length === 0) {
        await complete(job, 'retry', null, false, 'no_chunks')
        retried++
        continue
      }
      const truncated = allPieces.length > MAX_CHUNKS_PER_DOC
      const pieces = truncated ? allPieces.slice(0, MAX_CHUNKS_PER_DOC) : allPieces

      const payload: ChunkPayload[] = []
      let aborted = false
      for (let i = 0; i < pieces.length; i++) {
        // Deadline-check before each embedding call.
        if (Date.now() - startedAt > RUN_DEADLINE_MS) {
          await complete(job, 'retry', null, false, 'embedding_deadline')
          retried++
          aborted = true
          break
        }
        let embedding: number[]
        try {
          const result = await model.run(pieces[i], { mean_pool: true, normalize: true })
          embedding = result as number[]
        } catch {
          await complete(job, 'retry', null, false, 'embedding_error')
          retried++
          aborted = true
          break
        }
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
          await complete(job, 'retry', null, false, 'embedding_bad_dim')
          retried++
          aborted = true
          break
        }
        payload.push({ chunk_index: i, content: pieces[i], embedding })
      }
      if (aborted) continue

      const ok = await complete(job, 'done', payload, truncated, null)
      if (ok) {
        embedded_docs++
        total_chunks += payload.length
      }
    } catch {
      // Any unexpected/transient error → retry (complete caps it to failed at max attempts).
      await complete(job, 'retry', null, false, 'processing_error')
      retried++
    }
  }

  return Response.json({ enqueued, claimed, embedded_docs, total_chunks, retried, complete_errors })
})
