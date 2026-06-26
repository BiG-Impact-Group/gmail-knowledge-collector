# Epic 06 — vector-store

**Status:** Draft — pending Codex plan review
**Date:** 2026-06-26
**Base branch:** `test` (Epics 03/04/05 merged). Build branch: `feature/epic-06-vector-store`.
**Depends on:** Epic 05 (`documents.text_content` populated for `content_status='extracted'` Workspace files + converted binaries).

## Goal

Embed extracted document text **in-boundary** and store vectors for retrieval (Epic 07). No external API/model: embeddings come from Supabase Edge Runtime's built-in `gte-small` (`new Supabase.ai.Session('gte-small')`, 384-dim, `mean_pool:true, normalize:true`). No user-visible UI this epic — it populates a `chunks` table that Epic 07's RAG queries. Verified at the DB level.

## Confirmed gate (gte-small)

Supabase docs confirm `gte-small` runs natively in Edge Functions (edge-runtime ≥ v1.36.0), no external call: `const model = new Supabase.ai.Session('gte-small'); const embedding = await model.run(content, { mean_pool: true, normalize: true })` → 384-dim. Normalized vectors → use inner-product distance (`vector_ip_ops`) HNSW index (IP == cosine for unit vectors). Dimension is fixed at 384 at migration time.

## Design — mirror Epic 05's hardened job pipeline

Epic 06 is a second processing stage with the **same concurrency hazards** Epic 05 already solved. Reuse that exact pattern (advisory + row locks, lease guard, lifecycle-version + content-version rechecks, account→document→job lock order, claim-one-at-a-time, cap-fail). A separate `embedding_jobs` queue keeps stages independent (file-conversion vs embedding).

### Safety rules
1. **In-boundary only.** Embeddings via `Supabase.ai` gte-small inside the edge function. Chunk text + vectors stored in Supabase. Nothing leaves the boundary.
2. **Browser read-only.** `chunks` + `embedding_jobs`: SELECT-own RLS + `REVOKE INSERT/UPDATE/DELETE FROM anon, authenticated`. Writes via service_role SECURITY DEFINER RPCs only.
3. **Composite FK** `(user_id, document_id) → documents(user_id, id)` on both `chunks` and `embedding_jobs` (cross-user guard; `documents` already has `UNIQUE(user_id,id)` from Epic 05).
4. **Untrusted content.** Chunk text is still untrusted; Epic 07 applies injection shielding before any generative step. Embedding the text does not execute it.
5. Secrets in Vault; no content/PII in logs (job `last_error` = fixed codes).

## Data model

### Migration 1 — `enable_pgvector`
`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;` (idempotent).

### Migration 2 — `chunks`
```sql
CREATE TABLE IF NOT EXISTS chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL,
  chunk_index   integer NOT NULL,
  content       text NOT NULL,
  embedding     extensions.vector(384) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_doc_index_unique UNIQUE (document_id, chunk_index),
  CONSTRAINT chunks_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users select own chunks" ON chunks FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
REVOKE INSERT, UPDATE, DELETE ON chunks FROM anon, authenticated;
GRANT SELECT ON chunks TO authenticated;
-- ANN index for normalized gte-small vectors (inner product == cosine):
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding extensions.vector_ip_ops);
CREATE INDEX IF NOT EXISTS chunks_user_id_idx ON chunks (user_id);
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
```
Source scoped to **documents** this epic; a `source_type` (+ message_id) can be added later for email-body embedding without disturbing this schema. Self-repair DO-blocks for FK/policy (mirror Epic 05).

### Migration 3 — `embedding_jobs` + RPCs (mirror processing_jobs)
`embedding_jobs` table identical in shape to `processing_jobs` (id, user_id, document_id UNIQUE, status pending|processing|done|failed, attempts, last_error, claimed_at, timestamps; composite FK; RLS SELECT-own + REVOKE DML; claim index). RPCs (`SECURITY DEFINER SET search_path=public`, service_role only), copied from Epic 05's hardened versions with embedding semantics:

- **`enqueue_embedding_jobs()`** — insert a pending job for every `documents` row with `content_status='extracted' AND text_content IS NOT NULL`; ON CONFLICT reopen terminal jobs (so a re-extracted/changed doc re-embeds).
- **`claim_embedding_jobs(p_limit, p_stale_seconds, p_max_attempts)`** — same as `claim_processing_jobs`: cap-fail stale-over-max jobs, `FOR UPDATE SKIP LOCKED`, active google_drive account join, `d.content_status='extracted'` eligibility, returns lease (claimed_at) + lifecycle_version + drive_modified_time + the document's text via... NO — do not return large text from the RPC; return `document_id` and the edge function reads `text_content` separately under no lock (it's the user's own data; the complete RPC re-verifies version). Return `(job_id, document_id, user_id, attempts, claimed_at, connected_account_id, lifecycle_version, drive_modified_time)`.
- **`complete_embedding_job(p_job_id, p_claimed_at, p_attempts, p_lifecycle_version, p_drive_modified_time, p_outcome, p_chunks jsonb, p_error, p_max_attempts)`** — same lock order as Epic 05's fixed `complete_processing_job` (account→document→job), same lease + lifecycle + content-version + `content_status='extracted'` rechecks. On `'done'`: `DELETE FROM chunks WHERE document_id=v_doc` then bulk-insert `p_chunks` (array of {chunk_index, content, embedding}). On `'retry'`/cap → job failed (no document status change — documents stays 'extracted'; embedding is best-effort and does not regress the viewer). No `'skipped'` document mutation (embedding failure must not hide the document text).

> Embedding failures never change `documents.content_status` — the extracted text stays visible regardless; only retrieval coverage is affected.

### Migration 4 — `embedder_cron`
pg_cron `embed-documents-every-5min` → `net.http_post` to `embedder` with `CRON_SECRET` (mirror processor_cron). Scheduled LAST.

## Edge function — `embedder`
CRON_SECRET bearer. Constants: `MAX_JOBS_PER_RUN=3`, `STALE_SECONDS=600`, `MAX_ATTEMPTS=3`, `RUN_DEADLINE_MS=50_000`, `CHUNK_TARGET_CHARS=1500`, `CHUNK_OVERLAP_CHARS=200`, `MAX_CHUNKS_PER_DOC=200`. Per run: `enqueue_embedding_jobs()`, then claim-one-at-a-time (deadline-gated, like Epic 05):
1. Read `documents.text_content` for the job's document (service role).
2. **Chunk** the text (pure helper `chunkText`): split on paragraph/sentence boundaries into ~`CHUNK_TARGET_CHARS` windows with `CHUNK_OVERLAP_CHARS` overlap; cap at `MAX_CHUNKS_PER_DOC` (excess → truncate, log a count, no PII).
3. **Embed** each chunk: `await model.run(chunk, { mean_pool: true, normalize: true })` (one `Supabase.ai.Session('gte-small')` per run). On model error → `complete(..., 'retry')`.
4. `complete_embedding_job(..., 'done', chunks=[{chunk_index, content, embedding}])` — RPC deletes old chunks + inserts new, under the locks/guards. Pass the lease + lifecycle_version + drive_modified_time.
5. Check the complete RPC error (don't count a failed completion as success). Return `{ enqueued, claimed, embedded_docs, total_chunks, retried, complete_errors }`.

**Pure helper** `src/lib/chunking.ts`: `chunkText(text, {targetChars, overlapChars, maxChunks})` → `string[]` — unit-tested (boundary splitting, overlap, max-chunk cap, empty/whitespace input).

## Cross-epic tweak
None required: `enqueue_embedding_jobs` discovers extracted docs directly via `content_status='extracted'`, so Epic 05 needs no change. (When Epic 05 re-extracts a changed file, `drive_modified_time` changed → the embedding job's content-version recheck forces a re-embed.)

## Deployment order
1. Migration 1 `enable_pgvector` → confirm Remote.
2. Migration 2 `chunks` → confirm Remote → `gen:types`, commit.
3. Migration 3 `embedding_jobs` + RPCs → confirm Remote → `gen:types`, commit.
4. Deploy `embedder` edge function.
5. Smoke-invoke with `CRON_SECRET` (no extracted docs → zeros; else embeds).
6. Migration 4 `embedder_cron`.

## Tests
- `src/lib/chunking.test.ts`: target size, overlap, max-chunk cap, empty/whitespace, no mid-word explosion.
- Migration/RLS: `chunks` + `embedding_jobs` authenticated cannot DML, SELECT own only; composite FK rejects cross-user; RPCs not executable by anon/authenticated; claim concurrency-safe + active-account + content_status='extracted'; complete lease+lock-order+version rechecks; HNSW index exists.
- Embedding/retrieval validated at DB level (query chunks count + a sample `ORDER BY embedding <#> query_embedding`).

## Rollback runbook
1. `SELECT cron.unschedule('embed-documents-every-5min');`
2. Disable/redeploy `embedder`. Additive data: `chunks`/`embedding_jobs` don't affect the viewer; to re-embed, delete a doc's chunks + its embedding_job. pgvector extension stays.

## Work units
| # | Unit |
|---|---|
| EU-06-1 | Migration: enable pgvector |
| EU-06-2 | Migration: chunks table (vector(384), HNSW ip index, RLS, composite FK, self-repair) |
| EU-06-3 | Migration: embedding_jobs + enqueue/claim/complete RPCs (mirror hardened Epic 05) |
| EU-06-4 | Migration: embedder_cron (last) |
| EU-06-5 | Edge function: embedder (chunk → gte-small embed → complete) |
| EU-06-6 | Pure helper + tests: src/lib/chunking.ts |
| EU-06-7 | gen:types + commit (paired with migrations 2 & 3) |
| EU-06-8 | Migration/RLS tests |
