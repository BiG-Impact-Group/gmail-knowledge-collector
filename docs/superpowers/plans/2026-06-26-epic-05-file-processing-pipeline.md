# Epic 05 — file-processing-pipeline

**Status:** Draft — pending Codex plan review
**Date:** 2026-06-26
**Base branch:** `test` (Epic 03 + 04 merged). Build branch: `feature/epic-05-file-processing-pipeline`.
**Depends on:** Epic 04 (`documents` table, `content_status='needs_processing'` rows).

## Goal

Convert the binary files Epic 04 stored metadata-only (`content_status='needs_processing'` — Word, Excel, text-layer PDF) into text/markdown, **entirely in-boundary** (JS/WASM libraries, no external API or model). Scanned/image-only PDFs are marked `needs_ocr` (a later OCR worker is a second consumer of the same queue). The extracted text lands in the existing `documents.text_content`, so the `/documents` viewer renders it with no frontend change.

## Phase 0 gate

Confirm before implementing: Epic 04 is in `test`/Remote — `documents` table exists with `content_status` CHECK `('extracted','needs_processing','needs_ocr','skipped')` and the `documents_content_status_idx` partial index. Verified present 2026-06-26.

## Safety rules compliance

1. **In-boundary only.** File bytes are fetched from Google Drive using the account's Vault-stored refresh token (service role), converted inside the edge function with bundled JS/WASM libs, and the text is written back to Supabase. No content is sent to any external API or model. (Brief safety rule 8; brainstorm decision 1.)
2. **Tokens server-side only.** The processor reads the refresh token via `get_vault_secret` (service role), refreshes an access token, never returns/logs it.
3. **Browser read-only.** `processing_jobs` gets a SELECT-own RLS policy and no authenticated INSERT/UPDATE/DELETE. Only the edge function writes, via SECURITY DEFINER RPCs granted to `service_role`.
4. **Untrusted content.** Extracted markdown is still untrusted; the viewer renders it as plain text only (Epic 04 already enforces this). Prompt-injection shielding is deferred to Epic 07's RAG step.
5. **Secrets never in git.** `CRON_SECRET`, `GOOGLE_CLIENT_*` stay in Vault.
6. **No PII in logs.** Job `last_error` and console logs carry error codes/types only — never file names or content.

## Where extracted content lives (open question 1 → resolved)

Reuse `documents.text_content` (+ flip `content_status`). No new `markdown` column, no separate `extracted_content` table. Rationale: the `/documents` viewer already renders `text_content` as plain text and shows status-based messages; writing there means the converted file appears immediately with zero frontend change. The `processing_jobs` queue keeps conversion state separate from the rendered content, so we don't overload `content_status`.

Email attachments (brainstorm decision 5) are **deferred**: the Gmail collector does not currently capture attachments, so there is nothing to enqueue. The pipeline is built source-agnostic (`processing_jobs.source_type`) so an `email_attachment` producer can be added later without schema change.

## Data model

### Migration 1 — `documents_user_id_unique` (FK target)

`processing_jobs` needs a composite FK to `documents(user_id, id)` for the same cross-user write integrity guarantee as `messages`/`documents`. `documents.id` is the PK; add `UNIQUE(user_id, id)` so it can be an FK target (idempotent DO-block, mirrors `20260618000002`).

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name='documents' AND constraint_name='documents_user_id_id_key') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_user_id_id_key UNIQUE (user_id, id);
  END IF;
END $$;
```

### Migration 2 — `processing_jobs`

```sql
CREATE TABLE IF NOT EXISTS processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL,
  source_type   text NOT NULL DEFAULT 'drive'
                 CONSTRAINT processing_jobs_source_type_check CHECK (source_type IN ('drive','email_attachment')),
  status        text NOT NULL DEFAULT 'pending'
                 CONSTRAINT processing_jobs_status_check CHECK (status IN ('pending','processing','done','needs_ocr','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  claimed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- one job per document; producer upserts ON CONFLICT DO NOTHING
  CONSTRAINT processing_jobs_document_unique UNIQUE (document_id),
  -- composite FK: a job's (user_id, document_id) must match a real documents (user_id, id)
  CONSTRAINT processing_jobs_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);

ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='processing_jobs'
                 AND policyname='users select own processing jobs') THEN
    CREATE POLICY "users select own processing jobs" ON processing_jobs FOR SELECT
      TO authenticated USING ((select auth.uid()) = user_id);
  END IF;
END $$;

-- claim scan: pending first, then stale-claimed reclaim
CREATE INDEX IF NOT EXISTS processing_jobs_claim_idx
  ON processing_jobs (status, claimed_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS processing_jobs_user_id_idx ON processing_jobs (user_id);
```

No `'failed'` terminal state on `documents` — permanent failures live on the job row (`status='failed'`), and the document is set to `'skipped'` (viewer shows "content not available"). Transient failures stay retryable until `MAX_ATTEMPTS`.

### Migration 3 — RPCs (all SECURITY DEFINER, service_role only)

**`enqueue_processing_jobs()`** — producer. Inserts a `pending` job for every `documents` row that is `content_status='needs_processing'` and has no existing job. `ON CONFLICT (document_id) DO NOTHING` (so a failed job is never re-enqueued). Returns count enqueued.

```sql
CREATE OR REPLACE FUNCTION enqueue_processing_jobs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO processing_jobs (user_id, document_id, source_type)
  SELECT d.user_id, d.id, 'drive'
  FROM documents d
  WHERE d.content_status = 'needs_processing'
  ON CONFLICT (document_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
```

**`claim_processing_jobs(p_limit integer, p_stale_seconds integer)`** — atomically claims a batch. `FOR UPDATE SKIP LOCKED` so concurrent runs never double-claim. Picks `pending` jobs and `processing` jobs whose `claimed_at` is older than `p_stale_seconds` (crashed-run reclaim). Marks them `processing`, bumps `attempts`, sets `claimed_at`. Returns the jobs joined to the document + owning account so the worker can fetch the file.

```sql
CREATE OR REPLACE FUNCTION claim_processing_jobs(p_limit integer, p_stale_seconds integer)
RETURNS TABLE (
  job_id uuid, document_id uuid, user_id uuid, attempts integer,
  drive_file_id text, mime_type text, connected_account_id uuid, doc_name text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT pj.id FROM processing_jobs pj
    WHERE pj.status = 'pending'
       OR (pj.status = 'processing' AND pj.claimed_at < now() - make_interval(secs => p_stale_seconds))
    ORDER BY pj.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE processing_jobs pj
    SET status='processing', claimed_at=now(), attempts=pj.attempts+1, updated_at=now()
    FROM picked
    WHERE pj.id = picked.id
  RETURNING pj.id, pj.document_id, pj.user_id, pj.attempts,
            (SELECT d.drive_file_id FROM documents d WHERE d.id=pj.document_id),
            (SELECT d.mime_type FROM documents d WHERE d.id=pj.document_id),
            (SELECT d.connected_account_id FROM documents d WHERE d.id=pj.document_id),
            (SELECT d.name FROM documents d WHERE d.id=pj.document_id);
END; $$;
```

**`complete_processing_job(p_job_id uuid, p_document_id uuid, p_outcome text, p_text text, p_error text, p_max_attempts integer)`** — finalizes one job atomically under an advisory lock on the document. Outcomes:
- `'extracted'` → `documents.text_content = p_text`, `content_status='extracted'`; job `status='done'`.
- `'needs_ocr'` → `documents.content_status='needs_ocr'`; job `status='needs_ocr'`.
- `'skipped'` → `documents.content_status='skipped'`; job `status='failed'`, `last_error=p_error` (permanent/unsupported).
- `'retry'` → if `attempts >= p_max_attempts`: document `'skipped'`, job `status='failed'`; else job back to `status='pending'`, `claimed_at=NULL`, `last_error=p_error` (document stays `needs_processing`).

All three RPCs: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`.

### Migration 4 — `processor_cron`

pg_cron job `process-files-every-5min` → `net.http_post` to `file-processor` with the `CRON_SECRET` bearer (mirror `drive_cron`). Scheduled LAST, after the function is deployed and smoke-tested.

## Edge function — `file-processor`

CRON_SECRET bearer auth (like the collectors). Per run:

1. `enqueue_processing_jobs()` — pick up new `needs_processing` documents.
2. `claim_processing_jobs(MAX_JOBS_PER_RUN, STALE_SECONDS)` — claim a batch (`MAX_JOBS_PER_RUN=3`, `STALE_SECONDS=600`).
3. For each claimed job:
   a. Group by `connected_account_id`; per account, read refresh token (`get_vault_secret`), refresh access token (reuse the collectors' refresh helper).
   b. Download bytes: `GET /drive/v3/files/{drive_file_id}?alt=media` (Workspace exports were already handled in Epic 04; this path only sees true binaries). Bounded read with a hard cap `MAX_FILE_BYTES = 10 MB` (Content-Length pre-check); over cap → `complete(..., 'skipped', error='file_too_large')`.
   c. Convert by `mime_type`:
      - `application/pdf` → `unpdf` `extractText`. If the concatenated text is empty/whitespace → `needs_ocr`. Else `extracted` (markdown = page texts joined with blank lines).
      - `…wordprocessingml.document` (.docx) → unzip with `fflate`, read `word/document.xml`, extract `<w:t>` runs, join paragraphs (`<w:p>`) with newlines → markdown.
      - `…spreadsheetml.sheet` (.xlsx) → SheetJS read; each sheet → markdown table (or CSV) prefixed with `## <sheetName>`.
      - Legacy binary (`application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`, `…presentationml.presentation`, `application/rtf`) → not supported by the JS/WASM libs in-boundary → `complete(..., 'skipped', error='unsupported_type')`. (A future worker can revisit.)
   d. Truncate extracted markdown to `MAX_MARKDOWN_BYTES = 1 MB`.
   e. On success → `complete_processing_job(..., 'extracted'|'needs_ocr', text)`. On thrown/transient error → `complete_processing_job(..., 'retry', error=<code>)`.
4. Return `{ enqueued, claimed, extracted, needs_ocr, skipped, retried }`.

**Pure, unit-tested helpers** (extracted to `src/lib/file-processing.ts`, mirroring the gmail/drive pure-helper pattern):
- `classifyConversion(mimeType)` → `'pdf' | 'docx' | 'xlsx' | 'unsupported'`.
- `extractDocxText(zipEntryXml: string)` → strips `<w:t>`/`<w:p>` to text (testable on a fixture XML string).
- `isLikelyScanned(pdfText: string)` → empty/whitespace test → needs_ocr decision.
- `truncateUtf8(s, maxBytes)` → byte-bounded truncation.

### Libraries (open question 3 → pinned)
- PDF: `unpdf` (Deno/serverless pdf.js wrapper) via `https://esm.sh/unpdf@<pinned>`.
- docx: `fflate` (`https://esm.sh/fflate@<pinned>`) for unzip + manual `word/document.xml` text extraction (no DOM dependency).
- xlsx: SheetJS `https://esm.sh/xlsx@<pinned>` (`read` + `sheet_to_csv`).
Builder pins exact versions and verifies they import under the edge runtime during implementation; if `unpdf` proves unviable in the runtime, fall back to marking all PDFs `needs_ocr` for now and note it (PDF text extraction becomes a second-pass), rather than blocking the docx/xlsx paths.

## Deployment order

1. **Migration 1** `documents_user_id_unique` → confirm Remote.
2. **Migration 2** `processing_jobs` → confirm Remote → `gen:types`, commit.
3. **Migration 3** RPCs → confirm Remote → `gen:types`, commit.
4. **Deploy** `file-processor` edge function.
5. **Smoke-invoke** with `CRON_SECRET` (no needs_processing docs → `{enqueued:0,...}`; or against a real binary → converts).
6. **Migration 4** `processor_cron` → confirm Remote.
7. Frontend copy tweak (below) build + deploy.

## Frontend (minimal)

No new routes. One copy change in `DocumentDetail`: the `needs_processing` message becomes "Processing…" (was "Content extraction pending (Epic 05)"), since extraction is now active. `needs_ocr`/`skipped` messages unchanged. Optional: a small "Processing N files" hint on `/documents` if a `useProcessingJobs` count is cheap — but not required; keep scope tight.

## Tests

- `src/lib/file-processing.test.ts`: `classifyConversion` table; `extractDocxText` on a fixture XML; `isLikelyScanned` empty vs text; `truncateUtf8` boundary (no mid-codepoint split).
- Migration/RLS: `processing_jobs` authenticated cannot INSERT/UPDATE/DELETE, can SELECT own only; composite FK rejects a job whose `user_id` doesn't own `document_id`; RPCs not executable by anon/authenticated; `claim_processing_jobs` marks `processing` + bumps attempts and is concurrency-safe (`SKIP LOCKED`); `complete_processing_job` retry path flips to `failed`+document `skipped` at `MAX_ATTEMPTS`.
- (Edge function conversion itself is validated in the browser smoke test against real Drive binaries.)

## Rollback runbook

1. `SELECT cron.unschedule('process-files-every-5min');` (idempotent).
2. Redeploy/disable `file-processor` if faulty.
3. Data is additive: `processing_jobs` rows and `documents.text_content`/`content_status` flips don't destroy anything; to reset a document for reprocessing, delete its `processing_jobs` row and set `content_status='needs_processing'`. Never touch Vault outside lifecycle paths.

## Work units

| # | Unit |
|---|---|
| EU-05-1 | Migration: documents UNIQUE(user_id, id) |
| EU-05-2 | Migration: processing_jobs table + RLS + indexes + composite FK |
| EU-05-3 | Migration: enqueue/claim/complete RPCs (service_role only) |
| EU-05-4 | Migration: processor_cron (scheduled last) |
| EU-05-5 | Edge function: file-processor (enqueue→claim→convert→complete) |
| EU-05-6 | Pure helpers + tests: src/lib/file-processing.ts |
| EU-05-7 | Frontend copy tweak in DocumentDetail (needs_processing → "Processing…") |
| EU-05-8 | gen:types + commit (paired with migrations 2 & 3) |
| EU-05-9 | Migration/RLS tests |
