// Embeds extracted document text IN-BOUNDARY via Supabase.ai gte-small (384-dim). No content leaves
// the boundary (Rule 8). Reads documents.text_content, chunks it, embeds, stores vectors in `chunks`
// via the SECURITY DEFINER progress_embedding_job RPC. Best-effort: NEVER mutates documents. No PII
// in logs. `Supabase.ai` is a runtime global (not importable).
//
// RESUMABLE DESIGN (fix for the 2s edge CPU limit): Edge Functions enforce a hard ~2s CPU budget
// per request, and gte-small inference is CPU-bound. Production evidence: any request embedding a
// whole doc (15+ chunks) was killed with 546 WORKER_RESOURCE_LIMIT — even solo. Only 1–2 chunk
// requests ever completed. So each request claims ONE job, embeds CHUNKS_PER_REQUEST chunks from
// the job's next_chunk_index cursor, and commits that batch ('progress' advances the cursor and
// releases the job; 'done' finishes it). Progress is monotonic — a killed request loses only its
// in-flight batch. Throughput comes from many small invocations (cron fires several per tick).
//
// The pure chunker (chunkText) mirrors src/lib/chunking.ts (edge functions cannot import from src/).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const Supabase: {
  ai: { Session: new (model: string) => { run: (input: string, opts: Record<string, unknown>) => Promise<unknown> } }
}

const CHUNKS_PER_REQUEST = 2    // empirically proven to fit the 2s CPU budget (incl. model init)
const MAX_CHUNKS_PER_DOC = 50   // total per-document cap across all requests; excess → truncated
const STALE_SECONDS = 180       // a lease only covers one small batch (~seconds); reclaim fast
const MAX_ATTEMPTS = 3          // guards zero-progress claim loops (attempts reset on progress)
const RUN_DEADLINE_MS = 8_000
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
  next_chunk_index: number
}

interface ChunkPayload { chunk_index: number; content: string; embedding: number[] }

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')
  const authHeader = req.headers.get('Authorization')
  // Fail CLOSED: a missing/empty secret must never accept `Bearer undefined`/`Bearer `.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const startedAt = Date.now()
  let claimed = 0
  let committed_chunks = 0
  let finished = 0
  let retried = 0
  let rpc_errors = 0

  const model = new Supabase.ai.Session('gte-small')

  // Producer: enqueue jobs for extracted docs + purge stale chunks. Fail closed if it errors.
  const { error: enqErr } = await supabaseAdmin.rpc('enqueue_embedding_jobs')
  if (enqErr) {
    return Response.json({ error: 'enqueue_failed' }, { status: 500 })
  }

  async function report(
    job: ClaimedJob,
    outcome: 'progress' | 'done' | 'retry',
    chunks: ChunkPayload[],
    truncated: boolean,
    error: string | null,
  ): Promise<boolean> {
    const { error: rpcErr } = await supabaseAdmin.rpc('progress_embedding_job', {
      p_job_id: job.job_id,
      p_claimed_at: job.claimed_at,
      p_attempts: job.attempts,
      p_lifecycle_version: job.lifecycle_version,
      p_drive_modified_time: job.drive_modified_time,
      p_outcome: outcome,
      p_chunks: chunks,
      p_truncated: truncated,
      p_error: error,
      p_max_attempts: MAX_ATTEMPTS,
    })
    if (rpcErr) {
      // Transient DB error: the job stays 'processing' and is reclaimed after STALE_SECONDS.
      rpc_errors++
      return false
    }
    return true
  }

  // ONE job, ONE small batch per request — sized to the 2s CPU budget.
  while (claimed < 1 && Date.now() - startedAt <= RUN_DEADLINE_MS) {
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
        await report(job, 'retry', [], false, 'no_text')
        retried++
        continue
      }

      const text = (doc.text_content as string).slice(0, MAX_CONTENT_CHARS)
      // Deterministic chunker → identical boundaries on every request for the same text
      // (the claim RPC binds the job to a content version, so text can't change under us).
      const allPieces = chunkText(text, {
        targetChars: CHUNK_TARGET_CHARS,
        overlapChars: CHUNK_OVERLAP_CHARS,
        maxChunks: MAX_CHUNKS_PER_DOC + 1, // +1 slot to detect overflow → truncated flag
      })
      if (allPieces.length === 0) {
        await report(job, 'retry', [], false, 'no_chunks')
        retried++
        continue
      }
      const truncated = allPieces.length > MAX_CHUNKS_PER_DOC
      const pieces = truncated ? allPieces.slice(0, MAX_CHUNKS_PER_DOC) : allPieces

      const cursor = job.next_chunk_index
      if (cursor >= pieces.length) {
        // Cursor already at/past the end (previous request committed the final batch but died
        // before finishing, or chunking shrank). Close the job with an empty final batch.
        const ok = await report(job, 'done', [], truncated, null)
        if (ok) finished++
        continue
      }

      const slice = pieces.slice(cursor, cursor + CHUNKS_PER_REQUEST)
      const payload: ChunkPayload[] = []
      let failed = false
      for (let i = 0; i < slice.length; i++) {
        if (Date.now() - startedAt > RUN_DEADLINE_MS) break // commit what we have
        let embedding: number[]
        try {
          const result = await model.run(slice[i], { mean_pool: true, normalize: true })
          embedding = result as number[]
        } catch {
          failed = true
          break
        }
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
          failed = true
          break
        }
        payload.push({ chunk_index: cursor + i, content: slice[i], embedding })
      }

      if (payload.length === 0) {
        // No forward progress this request → retry (attempts cap it to failed if it never moves).
        await report(job, 'retry', [], false, failed ? 'embedding_error' : 'embedding_deadline')
        retried++
        continue
      }

      const isLast = !failed && cursor + payload.length >= pieces.length
      const ok = await report(job, isLast ? 'done' : 'progress', payload, truncated, null)
      if (ok) {
        committed_chunks += payload.length
        if (isLast) finished++
      }
    } catch {
      await report(job, 'retry', [], false, 'processing_error')
      retried++
    }
  }

  return Response.json({ claimed, committed_chunks, finished, retried, rpc_errors })
})
