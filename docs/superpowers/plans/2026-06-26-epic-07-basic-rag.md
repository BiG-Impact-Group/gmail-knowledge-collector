# Epic 07 — basic-rag (in-boundary retrieval-only)

**Status:** Draft — pending Codex plan review
**Date:** 2026-06-26
**Base branch:** `test` (Epics 03–06 merged). Build branch: `feature/epic-07-basic-rag`.
**Depends on:** Epic 06 (`chunks` table populated with gte-small 384-dim embeddings).

## Goal & scope decision

Answer a question over the user's collected data **as in-boundary semantic search with citations** — NOT generative text. Decision (confirmed with user 2026-06-26): the answer-generation LLM is **deferred**. Per Supabase docs, in-boundary LLMs (Ollama/Llamafile) need a self-managed inference host (the hosted LLM API is early-access only); standing that up + compliance review is the deferred work from the Scope-B brainstorm. Sending content to an external LLM violates safety rule 8 (PII never leaves the boundary). So Epic 07 ships the **retrieval half** of RAG: embed the query in-boundary (gte-small), match against `chunks` under the user's own isolation, return the top-K passages each with a citation to the source document. Generation layers on later with zero rework.

**No generative/agent step ⇒ no prompt-injection execution surface this epic.** Retrieved text is only displayed (as plain text), never fed to an LLM/tool. Injection shielding becomes required if/when generation is added (documented, not built).

## Safety rules
1. **In-boundary.** Query embedding via `Supabase.ai gte-small` in the edge function; the match runs in Postgres. Nothing leaves the boundary; no external model.
2. **Per-user isolation at query time (brainstorm Q1).** The `search` edge function verifies the caller's JWT (`getUser()`), derives `user_id` from the verified token, and restricts the match to that `user_id` (replicating RLS server-side; service role is used only to run the vector query, never to widen scope). Results can only ever be the caller's own chunks. Retrieved rows are further filtered to current, extracted content (`documents.content_status='extracted' AND chunks.source_version = documents.drive_modified_time`) so stale/superseded passages are never returned (Epic 06 contract).
3. **Browser stays read-only on collected data.** The search path is read-only; it returns chunk text + citation metadata the user already owns. No writes.
4. **Untrusted content** rendered as plain text only (no `dangerouslySetInnerHTML`), mirroring the documents viewer.
5. Tokens/secrets server-side; no PII in logs (log counts/latency only, never query text or results).

## Edge function — `search`
`verify_jwt = true` (only authenticated users; the platform rejects anon before our code runs). POST `{ query: string, limit?: number }`.
1. Validate `query` is a non-empty string ≤ a cap (e.g. 1000 chars); clamp `limit` to 1..10 (default 5).
2. `getUser()` from the Authorization header → `userId` (401 if absent/invalid).
3. Embed the query: `new Supabase.ai.Session('gte-small')` → `model.run(query, { mean_pool: true, normalize: true })` → 384-dim. (Same model/params as Epic 06 so query and document vectors share space.)
4. Call a SECURITY DEFINER RPC `match_chunks(p_user_id uuid, p_query_embedding vector(384), p_limit int)` with the service-role client, passing the **JWT-derived** `userId`. The RPC restricts to `c.user_id = p_user_id` and the freshness join, orders by `c.embedding <#> p_query_embedding`, returns top-K `{ document_id, document_name, web_view_link, content, distance }`.
   - Why an RPC with explicit `p_user_id` rather than the browser calling under RLS: the query embedding must be computed in-boundary (edge function), and the browser can't run gte-small. The edge function is the trust boundary; it pins `p_user_id` to the verified token, so a caller can never read another user's chunks. (RLS on `chunks` remains as defence in depth for any direct browser select.)
5. Return `{ results: [{ document_id, document_name, web_view_link, content, distance }], query_echo: query }`. Never log query/results.

`match_chunks` (SECURITY DEFINER, `SET search_path=public`, REVOKE from PUBLIC/anon/authenticated, GRANT service_role):
```sql
SELECT c.document_id, d.name AS document_name, d.web_view_link, c.content,
       (c.embedding <#> p_query_embedding) AS distance
FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE c.user_id = p_user_id
  AND d.content_status = 'extracted'
  AND c.source_version = d.drive_modified_time
ORDER BY c.embedding <#> p_query_embedding
LIMIT LEAST(GREATEST(p_limit, 1), 10);
```
Set `hnsw.ef_search` (e.g. `SET LOCAL hnsw.ef_search = 40`) inside the RPC for recall. `<#>` is negative inner product → ascending = most similar (normalized vectors).

## Service / hook / UI
- `src/services/search.service.ts`: `searchKnowledge(query, limit?)` → invokes the `search` edge function with the user's JWT (via the supabase client), returns typed results. (Service layer is the only Supabase touchpoint.)
- `src/hooks/useSearch.ts`: `useSearch()` — a mutation (React Query `useMutation`) that calls the service; exposes `results`, `isPending`, `error`. (Not a query — it's user-initiated.)
- `src/components/search/SearchPage.tsx` (+ `.module.scss`): a search box + submit; renders results as a list of cards — each shows the passage (plain text, clamped), the source document name linking to `web_view_link` (`rel="noopener noreferrer" target="_blank"`), and a relevance hint. Empty state ("Ask a question about your collected email and files"), loading state, no-results state, error state.
- Route `/ask` (or `/search`) + nav link alongside Emails/Documents. Auth-gated like the others.

## Deployment order
1. Migration `match_chunks_rpc` → confirm Remote → `gen:types`, commit.
2. Deploy `search` edge function (`verify_jwt=true`).
3. Smoke: authenticated POST with a query → returns the user's top matches (or empty if no chunks).
4. Frontend build + deploy (`/ask` route + nav).

No cron (query-time only). No new table.

## Tests
- `src/services/search.service.test.ts`: invokes the edge function with query/limit; returns typed results; propagates error; clamps/validates input shape on the client.
- `src/components/search/SearchPage.test.tsx`: empty/loading/results/no-results/error states; a result renders the passage as TEXT (html passage shows as markup, not rendered); source link has rel=noopener; submitting empty query is a no-op.
- Migration/RLS: `match_chunks` not executable by anon/authenticated (service_role only); returns only rows for the passed `p_user_id`; respects the extracted + version-match freshness filter; `LIMIT` clamp works.
- (Embedding/match quality validated in the browser smoke test against real data.)

## Rollback runbook
Additive + read-only. Disable/redeploy `search`; hide the `/ask` nav link. `match_chunks` is a pure read function; dropping it has no data impact. Nothing to purge.

## Work units
| # | Unit |
|---|---|
| EU-07-1 | Migration: match_chunks RPC (SECURITY DEFINER, user-pinned, freshness-filtered, service_role only) |
| EU-07-2 | Edge function: search (verify_jwt, getUser→userId, gte-small query embed, match_chunks, no PII logs) |
| EU-07-3 | search.service.ts |
| EU-07-4 | useSearch hook |
| EU-07-5 | SearchPage + SCSS (plain-text render, noopener citations, states) |
| EU-07-6 | Route /ask + nav link |
| EU-07-7 | gen:types + commit (paired with migration) |
| EU-07-8 | Service/component/RLS tests |
