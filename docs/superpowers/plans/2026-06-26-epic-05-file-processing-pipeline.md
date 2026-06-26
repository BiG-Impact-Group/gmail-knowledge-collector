# Epic 05 — file-processing-pipeline

**Status:** Rev 4 — Codex plan review v3 returned ZERO criticals (gate passed). Rev 4 adds the one residual important: claim returns drive_modified_time; complete rechecks it (content-version guard) so a file changing between claim and completion can't be overwritten with stale extraction.
**Date:** 2026-06-26
**Base branch:** `test` (Epic 03 + 04 merged). Build branch: `feature/epic-05-file-processing-pipeline`.
**Depends on:** Epic 04 (`documents` table, `content_status='needs_processing'` rows, `collect_account_documents` RPC).

## Goal

Convert the binary files Epic 04 stored metadata-only (`content_status='needs_processing'` — Word, Excel, text-layer PDF) into text/markdown, **entirely in-boundary** (JS/WASM libraries, no external API or model). Scanned/image-only PDFs are marked `needs_ocr` (a future OCR worker scans those separately). Extracted text lands in the existing `documents.text_content`, so the `/documents` viewer renders it with no frontend change.

## Phase 0 gate

Confirm before implementing: Epic 04 in `test`/Remote — `documents` table with `content_status` CHECK `('extracted','needs_processing','needs_ocr','skipped')`, `documents_content_status_idx`, and `collect_account_documents(uuid,jsonb,boolean,text,text,integer)` present. Verified 2026-06-26.

## Safety rules compliance

1. **In-boundary only.** File bytes fetched from Drive via the account's Vault refresh token (service role), converted inside the edge function with bundled JS/WASM libs, text written back to Supabase. No content to any external API/model. (Rule 8; brainstorm decision 1.)
2. **Tokens server-side only.** Token read via `get_vault_secret` (service role), never returned/logged.
3. **Browser read-only.** `processing_jobs`: SELECT-own RLS + explicit `REVOKE INSERT/UPDATE/DELETE FROM anon, authenticated`. All writes via SECURITY DEFINER RPCs granted to `service_role` only.
4. **Untrusted content.** Extracted markdown stays untrusted; the viewer renders it as plain text only (Epic 04). Injection shielding deferred to Epic 07.
5. **Secrets never in git.** `CRON_SECRET`, `GOOGLE_CLIENT_*` in Vault.
6. **No PII in logs.** Job `last_error` and logs carry fixed error codes only — never file names or content. The claim RPC does NOT return the file name.

## Where extracted content lives (resolved)

Reuse `documents.text_content` + flip `content_status`. No new column/table. The `/documents` viewer already renders `text_content` as plain text and shows status messages, so a converted file appears immediately. Conversion state lives on `processing_jobs`, separate from rendered content. Email attachments deferred (collector doesn't capture them); pipeline is source-agnostic via `processing_jobs.source_type` for a future producer.

## Data model

### Migration 1 — `collect_documents_preserve_processed` (CRITICAL, Codex v1 #1)

Epic 04's `collect_account_documents` upsert overwrites `text_content`/`content_status` on conflict, so the next Drive collector run would reset an Epic-05-extracted file back to `needs_processing`/null. Redefine the RPC (same signature, `CREATE OR REPLACE`) so that on conflict it **preserves** `text_content`/`content_status` when the file is unchanged (`drive_modified_time` equal), and only resets them when the file actually changed:

```sql
-- inside the ON CONFLICT (connected_account_id, drive_file_id) DO UPDATE of collect_account_documents:
  text_content = CASE WHEN documents.drive_modified_time IS DISTINCT FROM EXCLUDED.drive_modified_time
                      THEN EXCLUDED.text_content ELSE documents.text_content END,
  content_status = CASE WHEN documents.drive_modified_time IS DISTINCT FROM EXCLUDED.drive_modified_time
                        THEN EXCLUDED.content_status ELSE documents.content_status END,
  drive_modified_time = EXCLUDED.drive_modified_time,
  -- name, mime_type, web_view_link, size_bytes, updated_at always updated
```

Everything else in the RPC (advisory lock, `FOR UPDATE` row lock from Epic 04 cr v4, version guard, grants) is unchanged. Net effect: an unchanged file keeps its extracted markdown; a changed file resets to `needs_processing` (freshly classified), which the producer re-enqueues (below).

### Migration 2 — `documents_user_id_unique`

`processing_jobs` needs a composite FK to `documents(user_id, id)`. Add `UNIQUE(user_id, id)` on `documents` (idempotent DO-block, mirrors `20260618000002`).

### Migration 3 — `processing_jobs`

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
  CONSTRAINT processing_jobs_document_unique UNIQUE (document_id),
  CONSTRAINT processing_jobs_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);
```

Self-repair DO-blocks (Codex v1 #14) ensure the composite FK, CHECKs, and RLS policy exist even on a partially-created table. RLS + explicit grants (Codex v1 #9):

```sql
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;
-- SELECT-own policy via DO-block (idempotent)
CREATE POLICY "users select own processing jobs" ON processing_jobs FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);
-- Browser is read-only: no write policies, AND explicit table-privilege revoke.
REVOKE INSERT, UPDATE, DELETE ON processing_jobs FROM anon, authenticated;
GRANT SELECT ON processing_jobs TO authenticated;

CREATE INDEX IF NOT EXISTS processing_jobs_claim_idx
  ON processing_jobs (status, created_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS processing_jobs_user_id_idx ON processing_jobs (user_id);
```

Permanent failures live on the job (`status='failed'`); the document is set `'skipped'`. No `'failed'` document status needed.

### Migration 4 — RPCs (all `SECURITY DEFINER SET search_path = public`, schema-qualified refs, `REVOKE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`) (Codex v2 #3)

**`enqueue_processing_jobs()`** — producer. Inserts a `pending` job for every `documents` row with `content_status='needs_processing'`; on conflict **reopens** a terminal job (so a file that changed and was reset re-runs), but leaves in-flight jobs alone (Codex v1 #10):

```sql
INSERT INTO processing_jobs (user_id, document_id, source_type)
SELECT d.user_id, d.id, 'drive' FROM documents d WHERE d.content_status = 'needs_processing'
ON CONFLICT (document_id) DO UPDATE
  SET status='pending', attempts=0, claimed_at=NULL, last_error=NULL, updated_at=now()
  WHERE processing_jobs.status IN ('done','failed','needs_ocr');
```

**`claim_processing_jobs(p_limit int, p_stale_seconds int, p_max_attempts int)`** — returns `TABLE(job_id, document_id, user_id, attempts, claimed_at, drive_file_id, mime_type, connected_account_id, lifecycle_version, drive_modified_time)` (NO file name — Codex v1 #12). `drive_modified_time` is the file's value at claim time, used as a content-version token at completion (Codex v3). Steps:
1. **Cap-fail crashed jobs** (Codex v1 #4): stale `processing` jobs with `attempts >= p_max_attempts` → `status='failed', last_error='max_attempts'`, and their still-`needs_processing` documents → `content_status='skipped'`.
2. **Claim** with `FOR UPDATE OF pj SKIP LOCKED` (no double-claim), joining `documents` + `connected_accounts`, only for `ca.status='active' AND ca.provider='google_drive'` (Codex v1 #8). Eligible = `pending` OR (`processing` AND stale AND `attempts < p_max_attempts`). Set `status='processing', claimed_at=now(), attempts=attempts+1`. Return `claimed_at` (lease) + `lifecycle_version`.

**`complete_processing_job(p_job_id, p_claimed_at, p_attempts, p_lifecycle_version, p_drive_modified_time, p_outcome, p_text, p_error, p_max_attempts)`** — finalizes atomically with a **lease guard + document row lock + lifecycle recheck + content-version recheck**. Note there is NO `p_document_id` param — the document is derived from the job row so a caller bug can't write to the wrong document (Codex v2 #1):
1. **Lease guard, derives document_id:** `SELECT document_id INTO v_doc FROM processing_jobs WHERE id=p_job_id AND status='processing' AND claimed_at=p_claimed_at AND attempts=p_attempts FOR UPDATE;` If `NOT FOUND` → a newer attempt owns the job (or it was reset); **return without writing** (Codex v1 #3).
2. **Lock the document + recheck lifecycle + content version:** `SELECT d.content_status, d.drive_modified_time, ca.status, ca.lifecycle_version FROM documents d JOIN connected_accounts ca ON ca.id=d.connected_account_id WHERE d.id=v_doc FOR UPDATE OF d;` Then, any of these → **do not write the document**, set job `pending`/`claimed_at=NULL`, return:
   - document gone (account purged) → instead mark job `failed`/`document_gone`;
   - `ca.status<>'active'` OR `ca.lifecycle_version<>p_lifecycle_version` → disconnect/reconnect after claim (Codex v2 #2);
   - `d.drive_modified_time IS DISTINCT FROM p_drive_modified_time` → the file changed after claim and the collector already reset the document; this extraction is of stale content (Codex v3). A fresh job (re-enqueued by the producer) reprocesses the new version.
   The document `FOR UPDATE` serializes against `collect_account_documents`' row lock (Codex v1 #2).
3. Apply outcome:
   - `'extracted'` → `documents.text_content=p_text, content_status='extracted'`; job `done`.
   - `'needs_ocr'` → `documents.content_status='needs_ocr'`; job `needs_ocr`.
   - `'skipped'` → `documents.content_status='skipped'`; job `failed`, `last_error=p_error`.
   - `'retry'` → if `p_attempts >= p_max_attempts`: document `skipped`, job `failed`; else job `pending`, `claimed_at=NULL`, `last_error=p_error` (document stays `needs_processing`).

### Migration 5 — `processor_cron`

pg_cron `process-files-every-5min` → `net.http_post` to `file-processor` with `CRON_SECRET` bearer (mirror `drive_cron`). Scheduled LAST.

## Edge function — `file-processor`

CRON_SECRET bearer auth. Constants: `MAX_JOBS_PER_RUN=3`, `STALE_SECONDS=600`, `MAX_ATTEMPTS=3`, `MAX_FILE_BYTES=10_000_000`, `MAX_UNCOMPRESSED_BYTES=50_000_000`, `MAX_ZIP_ENTRIES=2000`, `MAX_MARKDOWN_BYTES=1_000_000`, `MAX_PDF_PAGES=200`, `MAX_XLSX_CELLS=200_000`, `RUN_DEADLINE_MS=50_000`.

Per run:
1. `enqueue_processing_jobs()`.
2. `claim_processing_jobs(MAX_JOBS_PER_RUN, STALE_SECONDS, MAX_ATTEMPTS)`.
3. For each claimed job (stop starting new jobs if `RUN_DEADLINE_MS` exceeded). Note: a single synchronous parser call cannot be preempted in Deno, so **per-file CPU is bounded by the input caps** (`MAX_FILE_BYTES`, `MAX_PDF_PAGES`, `MAX_XLSX_CELLS`, zip caps), not by a timer; the run deadline only gates whether the next file is started (Codex v2 #6):
   a. Per `connected_account_id`: `get_vault_secret`, refresh access token (reuse collector helper). Missing token → `complete(..., 'retry', 'no_token')`.
   b. **Bounded binary download** (Codex v1 #7): `readBytesBounded()` streams `GET /drive/v3/files/{id}?alt=media`, aborting once bytes exceed `MAX_FILE_BYTES` (never trusts Content-Length, never silently truncates binary). Over cap → `complete(..., 'skipped', 'file_too_large')`.
   c. Convert by `mime_type` with hard caps:
      - `application/pdf` → `unpdf` `extractText` (cap `MAX_PDF_PAGES`). Empty/whitespace across all pages → `needs_ocr`; else `extracted`.
      - `.docx` → `fflate` unzip but **zip-bomb guarded** (Codex v1 #5): reject if entry count > `MAX_ZIP_ENTRIES`, any entry or total uncompressed > caps; decompress **only** `word/document.xml`; extract `<w:t>`/`<w:p>` → markdown.
      - `.xlsx` → **same zip guard as docx first** (`zipWithinLimits` on entry count + uncompressed size — Codex v2 #5) before handing bytes to SheetJS `read`; reject if total cells across sheets > `MAX_XLSX_CELLS` (check `!ref` ranges before materializing); generate markdown sheet-by-sheet (`## sheet` + CSV) and **stop appending once `MAX_MARKDOWN_BYTES` is reached** (byte-bounded during generation, not after — Codex v2 #4).
      - legacy/other (`application/msword`, `…ms-excel`, `…ms-powerpoint`, `…presentationml.presentation`, `application/rtf`) → `complete(..., 'skipped', 'unsupported_type')`.
   d. Truncate markdown to `MAX_MARKDOWN_BYTES` (byte-bounded, no mid-codepoint split).
   e. Call `complete_processing_job(job_id, claimed_at, attempts, lifecycle_version, drive_modified_time, outcome, text, error, MAX_ATTEMPTS)` — passing the lease (`claimed_at`,`attempts`), `lifecycle_version`, and `drive_modified_time` from the claim. `outcome` = `'extracted'`/`'needs_ocr'` on success; `'retry'` on thrown/transient error; `'skipped'` on oversize/zip-bomb/unsupported.
4. Return `{ enqueued, claimed, extracted, needs_ocr, skipped, retried }`.

**Library viability gate (Codex v1 #13):** builder pins + verifies `unpdf`/`fflate`/`xlsx` import under the edge runtime during implementation. If `unpdf` is unviable, PDFs get `complete(..., 'retry', 'pdf_parser_unavailable')` (stays `needs_processing`, retryable) — **never** mislabeled `needs_ocr`. docx/xlsx paths ship regardless.

**Pure, unit-tested helpers** → `src/lib/file-processing.ts`:
- `classifyConversion(mimeType)` → `'pdf'|'docx'|'xlsx'|'unsupported'`.
- `extractDocxText(documentXml: string)` → text from `<w:t>`/`<w:p>`.
- `isLikelyScanned(pdfText)` → empty/whitespace → needs_ocr.
- `truncateUtf8(s, maxBytes)` → byte-bounded.
- `zipWithinLimits(entries)` → entry-count/uncompressed-size guard (pure, testable).

## Deployment order

1. **Migration 1** `collect_documents_preserve_processed` → confirm Remote.
2. **Migration 2** `documents_user_id_unique` → confirm Remote.
3. **Migration 3** `processing_jobs` → confirm Remote → `gen:types`, commit.
4. **Migration 4** RPCs → confirm Remote → `gen:types`, commit.
5. **Deploy** `file-processor`.
6. **Smoke-invoke** with `CRON_SECRET` (no needs_processing docs → zeros).
7. **Migration 5** `processor_cron`.
8. Frontend copy tweak build + deploy.

## Frontend (minimal)

`DocumentDetail` copy: `needs_processing` → "Processing…" (was "pending (Epic 05)"). `needs_ocr`/`skipped` unchanged. No new routes/queries.

## Tests (Codex v1 #15)

- `src/lib/file-processing.test.ts`: `classifyConversion` table; `extractDocxText` fixture; `isLikelyScanned` empty vs text; `truncateUtf8` boundary; `zipWithinLimits` accepts small / rejects over-entry / over-uncompressed (zip-bomb guard).
- Migration/RLS: `processing_jobs` authenticated cannot INSERT/UPDATE/DELETE (explicit privilege test, separate from RLS) and SELECTs own only; composite FK rejects mismatched `user_id`; RPCs not executable by anon/authenticated; `claim` marks `processing`+bumps attempts, is `SKIP LOCKED` concurrency-safe, only claims active google_drive accounts, caps-fails over-`MAX_ATTEMPTS` stale jobs; `complete` lease guard rejects a stale attempt (no document write); `complete` retry→failed+document `skipped` at cap.
- Collector interaction: `collect_account_documents` on conflict preserves `text_content`/`content_status` when `drive_modified_time` unchanged, resets when changed.
- Edge conversion validated in browser smoke test against real Drive binaries.

## Rollback runbook

1. `SELECT cron.unschedule('process-files-every-5min');`
2. Redeploy/disable `file-processor` if faulty. The Migration-1 `collect_account_documents` change is strictly safer (preserves more) and can stay.
3. Additive data: to reprocess a document, delete its `processing_jobs` row and set `content_status='needs_processing'`. Never touch Vault outside lifecycle paths.

## Work units

| # | Unit |
|---|---|
| EU-05-1 | Migration: collect_account_documents preserve processed content on unchanged drive_modified_time |
| EU-05-2 | Migration: documents UNIQUE(user_id, id) |
| EU-05-3 | Migration: processing_jobs table + RLS + explicit grants + indexes + composite FK + self-repair |
| EU-05-4 | Migration: enqueue/claim/complete RPCs (lease guard, account-active join, max-attempts, row lock) |
| EU-05-5 | Migration: processor_cron (scheduled last) |
| EU-05-6 | Edge function: file-processor (bounded download, zip-bomb guards, runtime caps, lib gate) |
| EU-05-7 | Pure helpers + tests: src/lib/file-processing.ts |
| EU-05-8 | Frontend copy tweak in DocumentDetail |
| EU-05-9 | gen:types + commit (paired with migrations 3 & 4) |
| EU-05-10 | Migration/RLS + collector-interaction tests |
