# Epic 06 — vector-store

**Status:** Rev 3 — Codex plan review v2 zero criticals (gate passed). Rev 3 folds the 3 residual importants: non-null content version + strict equality everywhere (no NULL-version leak), explicit SQL chunk-dimension validation before delete/insert, p_truncated param on complete. Ready for builder.
**Date:** 2026-06-26
**Base branch:** `test` (Epics 03/04/05 merged). Build branch: `feature/epic-06-vector-store`.
**Depends on:** Epic 05 (`documents.text_content` populated for `content_status='extracted'`).

## Goal

Embed extracted document text **in-boundary** (Supabase Edge Runtime built-in `gte-small`, 384-dim) and store vectors for Epic 07 retrieval. No external API/model. No user-visible UI; populates `chunks`. Verified at the DB level. **Document-only this epic** (email-body embedding is a later, separate source — `chunks.document_id` is NOT NULL, so it is genuinely document-scoped now; no false "polymorphic later" claim, Codex #10).

## Confirmed gate (gte-small)
`const model = new Supabase.ai.Session('gte-small'); const e = await model.run(text, { mean_pool: true, normalize: true })` → 384 normalized floats, in-boundary. Normalized → inner-product HNSW (`vector_ip_ops`), query `ORDER BY embedding <#> $q` (Codex #9). Dimension fixed at 384.

## Core correctness decisions (from review)

- **Content version everywhere (Codex C1/C2).** A document's `drive_modified_time` is its content version. `embedding_jobs.source_version` and `chunks.source_version` record the version they embedded. **Only documents with a non-null `drive_modified_time` are embedded**, and all comparisons use strict `=` (never `IS NOT DISTINCT FROM`), so a NULL version can never make a stale chunk look current (Codex v2). `chunks.source_version` is `NOT NULL`. Enqueue/reopen only when the version changed; retrieval and cleanup key off strict version equality so **stale chunks are never returned and are purged**. (Drive returns `modifiedTime` for real files; the rare NULL-modifiedTime doc simply isn't embedded — documented, acceptable.)
- **Embedding never regresses the document (Codex C3).** Neither `claim_embedding_jobs` cap-fail nor `complete_embedding_job` ever writes `documents` (no `content_status`/`text_content` mutation). Embedding is best-effort; the `/documents` viewer is unaffected by embedding failures.
- **Reuse the FINAL Epic 05 lock discipline (Codex #4):** base `complete_embedding_job` on `20260627020001_complete_job_lock_order.sql` — unlocked id derivation, then `connected_accounts → documents → embedding_jobs` lease lock, lifecycle + content-version + `content_status='extracted'` rechecks — replacing only the outcome (chunk delete+insert).

### Safety rules
In-boundary embeddings only; browser read-only on `chunks`/`embedding_jobs` (SELECT-own RLS + REVOKE DML); writes via service_role SECURITY DEFINER RPCs; composite FK `(user_id, document_id)→documents(user_id,id)`; idempotent migrations; chunk text untrusted (Epic 07 shields before generation); no PII in logs.

## Data model

### Migration 1 — `enable_pgvector`
`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;`

### Migration 2 — `chunks`
```sql
CREATE TABLE IF NOT EXISTS chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL,
  source_version  timestamptz NOT NULL,        -- documents.drive_modified_time embedded (always non-null; strict = comparisons)
  chunk_index     integer NOT NULL,
  content         text NOT NULL,
  embedding       extensions.vector(384) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_doc_index_unique UNIQUE (document_id, chunk_index),
  CONSTRAINT chunks_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);
```
RLS + grants + indexes, all via idempotent DO-blocks / `IF NOT EXISTS` (Codex #7):
```sql
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
-- DO-block create policy "users select own chunks" FOR SELECT TO authenticated USING ((select auth.uid())=user_id)
REVOKE ALL ON TABLE chunks FROM anon, authenticated;
GRANT SELECT ON chunks TO authenticated;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding extensions.vector_ip_ops);
CREATE INDEX IF NOT EXISTS chunks_user_id_idx ON chunks (user_id);
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
```
Self-repair DO-blocks ensure the composite FK + unique + policy exist on a partial table (mirror `processing_jobs`).

### Migration 2b — `documents_extracted_idx` (Codex #8)
Enqueue scans extracted docs every 5 min, but `documents_content_status_idx` excludes `extracted`. Add:
```sql
CREATE INDEX IF NOT EXISTS documents_extracted_idx ON documents (id)
  WHERE content_status = 'extracted';
```

### Migration 3 — `embedding_jobs` + RPCs
`embedding_jobs`: `processing_jobs` shape **plus** `source_version timestamptz`, `chunk_count integer`, `truncated boolean DEFAULT false` (Codex #11). Composite FK, RLS SELECT-own + REVOKE DML, claim index, self-repair — all idempotent.

**`enqueue_embedding_jobs()`** — version-aware (Codex C1). Insert/reopen only when the embedded version differs from the document's current version:
```sql
INSERT INTO public.embedding_jobs (user_id, document_id, source_version)
SELECT d.user_id, d.id, d.drive_modified_time
FROM public.documents d
WHERE d.content_status='extracted' AND d.text_content IS NOT NULL
  AND d.drive_modified_time IS NOT NULL   -- only embed docs with a real content version (Codex v2)
ON CONFLICT (document_id) DO UPDATE
  SET status='pending', attempts=0, claimed_at=NULL, last_error=NULL,
      source_version=EXCLUDED.source_version, updated_at=now()
  WHERE public.embedding_jobs.source_version IS DISTINCT FROM EXCLUDED.source_version;
```
A `done`/`failed` job for the **same** version is left alone → no infinite re-embed, no infinite failure-retry (Codex C1). A changed document (`drive_modified_time` differs) reopens.

**Stale-chunk purge (Codex C2)** — runs in `enqueue_embedding_jobs()` after the insert (or a dedicated `purge_stale_chunks()` called each run): delete chunks whose document is no longer extracted or whose version no longer matches:
```sql
DELETE FROM public.chunks c
WHERE NOT EXISTS (
  SELECT 1 FROM public.documents d
  WHERE d.id = c.document_id
    AND d.content_status = 'extracted'
    AND d.drive_modified_time = c.source_version   -- strict equality; both non-null
);
```
(FK cascade already removes chunks when a document/account is deleted; this also clears chunks for docs that went `needs_processing`/`needs_ocr`/`skipped` or whose content changed.)

**`claim_embedding_jobs(p_limit, p_stale_seconds, p_max_attempts)`** — like `claim_processing_jobs` BUT cap-fail touches **only `embedding_jobs`** (never documents — Codex C3). `FOR UPDATE OF pj SKIP LOCKED`; eligibility = active google_drive account + `d.content_status='extracted'` + `(pending OR stale processing under max)`. Returns `(job_id, document_id, user_id, attempts, claimed_at, connected_account_id, lifecycle_version, drive_modified_time)`. No text, no file name.

**`complete_embedding_job(p_job_id, p_claimed_at, p_attempts, p_lifecycle_version, p_drive_modified_time, p_outcome, p_chunks jsonb, p_truncated boolean, p_error, p_max_attempts)`** — based on `complete_job_lock_order.sql` (account→document→job locks; lease + lifecycle_version + strict `drive_modified_time =` + `content_status='extracted'` rechecks). **Never writes `documents`.** Note `p_truncated` is an explicit param (Codex #11; `chunk_count` is derived from `jsonb_array_length`). Outcomes:
- `'done'`: **validate `p_chunks` fully in SQL BEFORE any delete/insert (Codex v2 #6)** — `jsonb_array_length(p_chunks) BETWEEN 1 AND MAX_CHUNKS`; for every element assert integer `chunk_index`, non-empty `content` ≤ a length cap, and `jsonb_array_length(elem->'embedding') = 384`. If any check fails → job `failed`, `last_error='invalid_chunks'`, **return without touching chunks/documents** (don't rely on the `vector(384)` cast to throw mid-insert and abort the txn). On success: `DELETE FROM chunks WHERE document_id=v_doc;` then `INSERT` each chunk with `embedding = (elem->>'embedding')::extensions.vector` and `source_version = p_drive_modified_time`; set job `done`, `chunk_count = jsonb_array_length(p_chunks)`, `truncated = p_truncated`.
- `'retry'`: if `attempts >= max` → job `failed`; else job `pending`, `claimed_at=NULL`. (Document untouched either way.)

### Migration 4 — `embedder_cron`
pg_cron `embed-documents-every-5min` → `net.http_post` to `embedder` with `CRON_SECRET`. Scheduled LAST.

## Edge function — `embedder`
CRON_SECRET bearer. Calibrated caps (Codex #5): `MAX_JOBS_PER_RUN=2`, `MAX_CHUNKS_PER_DOC=50`, `STALE_SECONDS=600`, `MAX_ATTEMPTS=3`, `RUN_DEADLINE_MS=45_000`, `CHUNK_TARGET_CHARS=1500`, `CHUNK_OVERLAP_CHARS=200`, `MAX_CONTENT_CHARS=200_000` (cap text read). One `Supabase.ai.Session('gte-small')` per run. Per run: `enqueue_embedding_jobs()` (also purges stale chunks), then claim-one-at-a-time (deadline-gated):
1. Read `documents.text_content` (truncate to `MAX_CONTENT_CHARS`).
2. `chunkText(text, {...})` → ≤ `MAX_CHUNKS_PER_DOC` chunks (excess truncated → set `truncated=true`).
3. For each chunk: **deadline-check before each `model.run`** (Codex #5); if the deadline is near, `complete(..., 'retry', 'embedding_deadline')` and stop. Else embed.
4. `complete_embedding_job(..., 'done', p_chunks=[{chunk_index, content, embedding}], p_truncated)` with lease+lifecycle_version+drive_modified_time. Check the RPC error; don't count a failed completion as success.
5. Return `{ enqueued, claimed, embedded_docs, total_chunks, retried, complete_errors }`.

**Pure helper** `src/lib/chunking.ts`: `chunkText(text, {targetChars, overlapChars, maxChunks})` → `string[]`, unit-tested.

## Epic 07 retrieval contract (documented now, built in 07)
Retrieval MUST filter to current, extracted content so stale chunks are never returned (Codex C2/C9), and run under the user's RLS:
```sql
SELECT c.content, c.document_id
FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE d.content_status = 'extracted'
  AND c.source_version = d.drive_modified_time   -- strict equality; both non-null
ORDER BY c.embedding <#> $1   -- $1 = query embedding (gte-small, normalized)
LIMIT $2;
```
Tune `hnsw.ef_search` in Epic 07.

## Deployment order
1. Migration 1 `enable_pgvector` → confirm Remote.
2. Migration 2 `chunks` + 2b `documents_extracted_idx` → confirm Remote → `gen:types`, commit.
3. Migration 3 `embedding_jobs` + RPCs → confirm Remote → `gen:types`, commit.
4. Deploy `embedder`.
5. Smoke-invoke with `CRON_SECRET` (no extracted docs → zeros; else embeds; confirm chunk rows + dimension).
6. Migration 4 `embedder_cron`.

## Tests
- `src/lib/chunking.test.ts`: target size, overlap, max-chunk cap (+truncated signal), empty/whitespace, no mid-word loss.
- Migration/RLS: `chunks`/`embedding_jobs` authenticated cannot DML, SELECT own only; composite FK rejects cross-user; RPCs not anon/authenticated; `claim_embedding_jobs` cap-fail never touches documents; `complete_embedding_job` never writes documents, validates chunks (rejects non-384/empty), deletes+inserts under version recheck; `enqueue` is version-idempotent (no reopen for same version) and purges stale chunks; HNSW index + `vector(384)` present.
- DB-level retrieval sanity: insert→embed a sample doc, confirm chunk count + `ORDER BY embedding <#> q` returns it; change `drive_modified_time` → stale chunks purged + not returned.

## Rollback runbook
1. `SELECT cron.unschedule('embed-documents-every-5min');`
2. Disable/redeploy `embedder`. Additive: `chunks`/`embedding_jobs` don't affect the viewer; pgvector stays. To re-embed: delete a doc's chunks + its embedding_job (or bump nothing — enqueue re-embeds on version change).

## Work units
| # | Unit |
|---|---|
| EU-06-1 | Migration: enable pgvector |
| EU-06-2 | Migration: chunks (vector(384) + source_version, HNSW ip index, RLS, composite FK, self-repair) + documents_extracted_idx |
| EU-06-3 | Migration: embedding_jobs (+source_version/chunk_count/truncated) + enqueue(version-aware + stale-chunk purge)/claim(no doc mutation)/complete(no doc mutation, chunk validation, version-stamped) RPCs |
| EU-06-4 | Migration: embedder_cron (last) |
| EU-06-5 | Edge function: embedder (chunk → gte-small embed, deadline-gated → complete) |
| EU-06-6 | Pure helper + tests: src/lib/chunking.ts |
| EU-06-7 | gen:types + commit (paired with migrations 2 & 3) |
| EU-06-8 | Migration/RLS tests |
