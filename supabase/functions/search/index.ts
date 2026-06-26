// Epic 07 (basic-rag): in-boundary semantic search. Retrieval-only — NO generative/agent step,
// so there is no prompt-injection execution surface this epic. Retrieved chunk text is only
// returned to the browser for plain-text display; it is never fed to an LLM/tool.
//
// IN-BOUNDARY ONLY (Rule 8): the query is embedded with the built-in Supabase.ai gte-small model
// (same model/params as the embedder so query + document vectors share space). On ANY embedding
// failure we return a fixed 503 — we NEVER fall back to an external API.
//
// Per-user isolation: this function is deployed with verify_jwt=true (the platform rejects anon
// before our code runs). We build an anon-key client carrying the CALLER's Authorization header and
// call getUser() to confirm a real user, then call match_chunks under the SAME caller-JWT client.
// match_chunks is SECURITY INVOKER, so the chunks SELECT-own RLS policy scopes results to the
// caller. The service role is never used here — a caller can only ever read their own chunks.
//
// NEVER log the query or results (Rule: no PII in logs). Log counts/latency only.
//
// `Supabase.ai` is a runtime global in the Supabase Edge Runtime — NOT importable. Declared below
// so this file type-checks under tsc.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Supabase Edge Runtime global (not importable). Provides the in-boundary inference session.
declare const Supabase: {
  ai: { Session: new (model: string) => { run: (input: string, opts: Record<string, unknown>) => Promise<unknown> } }
}

const EMBEDDING_DIM = 384
const MAX_BODY_BYTES = 8 * 1024
const MAX_QUERY_CHARS = 1000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MIN_LIMIT = 1

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  // Cache-Control: no-store on EVERY response (incl. errors) — search responses are user PII (review v1).
  return Response.json(body, { status, headers: { ...corsHeaders, 'Cache-Control': 'no-store', ...extraHeaders } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } })
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  // AUTH GATE FIRST (review v1): verify the caller before doing any body read/parse work, so
  // unauthenticated traffic is 401'd up front even if platform JWT verification were ever disabled.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'unauthorized' }, 401)
  }
  // Anon-key client carrying the caller's JWT — match_chunks runs under the caller's RLS.
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401)
  }

  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return json({ error: 'unsupported_media_type' }, 415)
  }

  // Body size guard. Reject anything over the cap before parsing.
  const declaredLength = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413)
  }
  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return json({ error: 'invalid_body' }, 400)
  }
  const body = parsed as { query?: unknown; limit?: unknown }

  if (typeof body.query !== 'string') {
    return json({ error: 'invalid_query' }, 400)
  }
  const query = body.query.trim()
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    return json({ error: 'invalid_query' }, 400)
  }

  let limit = DEFAULT_LIMIT
  if (body.limit !== undefined) {
    const n = Math.floor(Number(body.limit))
    if (!Number.isFinite(n)) {
      return json({ error: 'invalid_limit' }, 400)
    }
    limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n))
  }

  const startedAt = Date.now()

  // Embed the query IN-BOUNDARY. On ANY failure → fixed 503. NEVER call an external API.
  let embedding: number[]
  try {
    const model = new Supabase.ai.Session('gte-small')
    const result = await model.run(query, { mean_pool: true, normalize: true })
    if (
      !Array.isArray(result) ||
      result.length !== EMBEDDING_DIM ||
      !result.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      console.error('embedding_unavailable: bad embedding shape')
      return json({ error: 'embedding_unavailable' }, 503)
    }
    embedding = result as number[]
  } catch {
    console.error('embedding_unavailable: session error')
    return json({ error: 'embedding_unavailable' }, 503)
  }

  // Match under the caller's RLS (SECURITY INVOKER RPC). No p_user_id — isolation is RLS.
  const { data, error } = await supabase.rpc('match_chunks', {
    p_query_embedding: embedding as unknown as string,
    p_limit: limit,
  })
  if (error) {
    console.error('match_failed')
    return json({ error: 'search_failed' }, 500)
  }

  const results = data ?? []
  // Log counts/latency only — NEVER the query or results.
  console.log(JSON.stringify({ event: 'search', count: results.length, ms: Date.now() - startedAt }))

  return json({ results }, 200, { 'Cache-Control': 'no-store' })
})
