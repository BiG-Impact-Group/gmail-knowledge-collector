# Scope B — Brainstorm Handoff Seed

**Date:** 2026-06-25
**What this is:** the starting point for the brainstorm sessions, carried over from the planning conversation. It is deliberately not a finished spec. The comprehensive per-epic spec is produced by `/brainstorm` and the planner together with the human, using this as the seed. This file exists so brainstorm does not re-derive the decisions or the repo grounding and can go straight to the few real design questions, listed per epic below.

**How to use it:** read this alongside `CLAUDE.md`, `docs/project-brief.md`, `docs/dev-rules.md`, and `docs/dev-rules-local-overrides.md`. `project-brief.md` is the project authority, `dev-rules.md` is the process authority, this file is the program seed for the next phase. It supersedes the Week 2 to 4 outlines in `docs/next-steps.md`; treat `next-steps.md` as a Drive code sketch only, not a plan.

---

## The phase, in one paragraph

The June 25 check-in set the next target at the halfway point: connect Google Drive, convert files to markdown, load embeddings into a vector store, and do a basic retrieve-and-answer over the collected data, with ruggedness around all of it. That is scope B. OAuth lifecycle hardening (reconnect, disconnect, delete) is pulled in first because it touches the existing Gmail path and is the foundation Drive builds on. Schema standardization and the shared-repo merge with Cloee are deferred, since they depend on her Microsoft-centric schema.

---

## Decisions already made (do not relitigate in brainstorm)

These were settled in planning. Rationale is included so brainstorm and both Codex reviews do not reopen them.

1. **Embeddings run in-boundary, never through an external model.** `project-brief.md` safety rule 3 already forbids sending collected content to any external model. The `next-steps.md` Week 4 OpenAI sketch contradicts that rule and is overridden. Consequence: the pgvector column dimension is fixed at migration time and an in-boundary model does not use OpenAI's 1536 dimensions, so the model and dimension are confirmed before the embedding column migration is written. No external provider, no demo-only toggle.
2. **Per-user isolation is reused, not reinvented.** The existing pattern is the isolation model: `user_id` on every table, a single `(select auth.uid()) = user_id` SELECT policy `TO authenticated`, no authenticated write policies, all writes by edge functions under the service role. This satisfies users self-serving and demoing their own accounts. New tables follow it. RLS must also constrain the retrieval path so one user cannot read another's chunks.
3. **The file-processing worker is TypeScript and Node**, consistent with the mandated stack. Hard conversion steps shell out to system binaries in the host-based path, so the language is not the quality bottleneck.
4. **Conversion is hybrid.** Build a jobs queue and implement an edge-function converter first (Word, Excel, text-layer PDF in JavaScript and WASM). Mark scanned or image-only PDFs as `needs_ocr` rather than dropping them. A dedicated OCR worker is a later, second consumer of the same queue, added when a real client corpus exists and the in-boundary host and compliance review are scoped. This keeps everything in-boundary with no new host and unblocks the vector and RAG epics now.
5. **One pipeline for Drive binaries and email attachments.** Email attachments need the same extraction as Drive binaries, so they enqueue into the same jobs table and share the converter, chunking, and vector table.

---

## Repo grounding (facts brainstorm should build on, not rediscover)

Established by reading the repo on 2026-06-25.

**Conventions (`CLAUDE.md`, `project-brief.md`):** service layer is the only browser path to Supabase, component to hook to service to client; edge functions are server-side under the service role and exempt. RLS is the authorization layer, per-operation policies `TO authenticated`, cached `(select auth.uid())` subselect, indexes on policy columns. Migrations are append-only, cloud-only, idempotent, with `npm run gen:types` output committed in the same commit, and every migration must appear in the Remote column of `npx supabase migration list --linked` before the PR. Validation in Zod. SCSS design tokens, no Tailwind, under the Stylelint gate. No client-state libraries. `@/` path alias. Linked Supabase project ref is `ybgtzyutbvwfhgtlmnah`.

**Schema today:** `connected_accounts` (per connected account: `user_id`, `provider`, `email_address`, `status` checked against active/error/revoked, `granted_scopes`, `sync_cursor`, `last_synced_at`, `backfill_complete`, `backfill_page_token`, `backfill_start_history_id`; `UNIQUE (user_id, email_address)` and `UNIQUE (user_id, id)`; RLS SELECT-own only). `messages` (denormalized `user_id`, composite FK `(user_id, connected_account_id)` into `connected_accounts(user_id, id)`, unique on `(connected_account_id, gmail_message_id)`; RLS SELECT-own only). `oauth_nonces` (service-role only, deny-all to the browser). Vault helpers exist for create, update, get, and get-id, but not delete. A pg_cron job invokes `gmail-collector` every 5 minutes with a `CRON_SECRET` bearer read from Vault.

**OAuth flow shape:** `google-oauth-initiate` verifies the user from the Authorization header, signs an HS256 state JWT carrying `user_id` and a nonce, stores the nonce, and redirects to Google with `access_type=offline` and `prompt=consent`. `google-oauth-callback` verifies the state, consumes the nonce once, exchanges the code, reads the account email from userinfo, upserts `connected_accounts` as `error`, stores the refresh token in Vault keyed by the account id, then marks the account `active`. The collector reads the token from Vault, refreshes, and on `invalid_grant` or `token_revoked` sets `status = 'error'`.

**Connector seam:** `src/types/connector.ts` defines `ConnectorConfig { provider, initiateUrl, callbackPath, scopes }`, and `gmail-collector` documents the seam. Drive fits it.

**Frontend to mirror:** email feature lives in `src/components/email/` (`EmailPage`, `MessageList`, `MessageItem`, `MessageDetail`), with `useMessages`, `useMessage`, `messages.service.ts`. Accounts in `src/components/accounts/` (`AccountsPage`, `AccountCard`) with `useAccounts`, `accounts.service.ts`. Shared `EmptyState`. The Drive and later views mirror these.

**Defects and gaps found, to be addressed in the relevant epic:**
1. `accounts.service.ts` has no disconnect, delete, or token revoke. `AccountCard` reconnect is hardcoded to `google`. Nothing calls Google's revoke endpoint, which is the bug where a connection looked disconnected but stayed authorized.
2. `connected_accounts` natural key `UNIQUE (user_id, email_address)` collides when the same Google account connects both Gmail and Drive. It needs to become provider-aware before Drive OAuth.
3. No `vault_delete_secret` helper exists; disconnect and delete need one.
4. The `next-steps.md` `documents` migration uses `ADD CONSTRAINT IF NOT EXISTS`, which Postgres does not support; use a DO-block guard like migration `20260618000002`.
5. The 200-message first-sync cap is gone; the Gmail backfill now paginates across cron runs. Backfill completeness for very large mailboxes and the lookback window are ruggedness items, not a hard cap.
6. Phase 0 Codex reconciliation items 2 and 3 (the `codex exec` invocation and the project-context in both Codex prompt templates) need a check before the review gates are trusted. The validation-gate project ref is already correct.

---

## Epic seeds for brainstorm

Run as five epics in order, one PR each against `test`. Numbers are suggestions; confirm the next free number at decomposition. For each epic, brainstorm expands the goal into the full spec by resolving the open questions, then the planner produces the design doc in `docs/superpowers/plans/`.

### Epic 03 — oauth-lifecycle (no dependency)

Goal: make a connection survive being broken and let the user control it. Disconnect (revoke at Google, stop syncing, keep data), delete (revoke, remove the connection, cascade its data), provider-aware reconnect, and the provider-aware unique key.

Grounding: defects 1, 2, and 3 above. Disconnect and delete must run in an edge function because the browser cannot call Google revoke or touch Vault. Status values active/error/revoked already exist.

Open questions for brainstorm:
1. On disconnect, keep collected data or purge it. Leaning keep on disconnect, purge only on delete.
2. Does delete always revoke at the provider first, or allow local-only removal when the token is already dead. Leaning always attempt revoke, treat an already-dead token as success.
3. Reuse `error` for needs-reauth, or add an explicit `needs_reauth` status that changes the CHECK. Leaning reuse `error`, no migration.

### Epic 04 — drive-collector (depends on 03)

Goal: connect Drive accounts and show files in a `/documents` viewer mirroring `/emails`. Store metadata plus text for Google Workspace files and small native text files. Binary files (Word, Excel, PDF) are stored as metadata only; their content is Epic 05.

Grounding: the `next-steps.md` Week 2 sketch is the starting code, with defect 4 fixed. Reuse the shared callback by carrying `provider` in the signed state. Reuse the existing sync and backfill columns with Drive semantics. Fits the connector seam.

Open questions for brainstorm:
1. Drive scope set: include `openid email` with `drive.readonly` so the callback's userinfo lookup still resolves the connection email, or derive the email another way. Leaning include `openid email`.
2. Personal Drive only for now, Shared Drives deferred. Confirm acceptable for the demo.
3. Separate `/documents` route, or a tab in a combined sources view. Leaning separate route.
4. Does Epic 04 enqueue Epic 05 jobs for binary files, or leave all enqueueing to Epic 05. Leaning leave it to Epic 05 to keep the boundary clean.

### Epic 05 — file-processing-pipeline (depends on 04)

Goal: convert Word, Excel, and text-layer PDF to markdown for both Drive binaries and email attachments, on the hybrid model in decision 4.

Grounding: a `processing_jobs` table on the per-user RLS pattern, a producer that scans for unconverted Drive binaries and email attachments, and an edge-function consumer driven by cron that converts a small batch per run and marks scanned PDFs `needs_ocr`.

Open questions for brainstorm:
1. Where converted markdown lives: a `markdown` column on `documents` and an equivalent for attachments, or a shared `extracted_content` table keyed by source. 
2. Per-run batch size, tuned to the verified edge-function CPU, memory, and wall-clock limits. Confirm the current limits during brainstorm rather than assume.
3. The specific JavaScript and WASM libraries for docx, xlsx, and PDF text, pinned and verified.
4. How email attachments are surfaced from the existing `messages` data so the producer can find them.

### Epic 06 — vector-store (depends on 05, and the embedding model and dimension confirmed first)

Goal: embed the markdown in-boundary and store vectors for retrieval.

Grounding: enable pgvector, a `chunks` table with `user_id`, a source reference, chunk text, chunk index, and `embedding vector(N)` where N is the chosen model's dimension; per-user SELECT RLS; an ANN index for the chosen distance metric; full source metadata so retrieval can cite the originating file or email.

Open questions for brainstorm:
1. The in-boundary embedding model and its dimension. Leading candidate to verify: the Supabase Edge Function built-in `gte-small`, in-boundary, 384 dimensions. If unavailable or unsuitable, the Epic 05 worker runs the model. This is a hard gate before the column migration.
2. Chunk size and overlap.
3. Distance metric and the matching index type.

### Epic 07 — basic-rag (depends on 06)

Goal: answer a question over the collected data with a citation.

Grounding: embed the query in-boundary, match against `chunks` under the requesting user's RLS context, assemble the top results into context, apply prompt-injection shielding to the retrieved content before any tool-calling step (brief safety rule 5), and answer with a source citation. Retrieval runs as the user, not the service role.

Open questions for brainstorm:
1. The matching function shape and how it runs under the user's JWT so isolation holds at query time.
2. The injection-shielding approach for retrieved content before it reaches any agent step.
3. What generates the answer, given the in-boundary constraint applies to content. Confirm whether the answer model is in-boundary too, or whether only retrieval and embeddings must stay in-boundary.

### Deferred — schema-standardization (depends on Cloee)

Reconcile with Cloee's Microsoft-centric schema and prepare the shared-repo merge. Not started until her decision.

---

## Cross-cutting invariants (every epic)

Service layer is the only browser path to Supabase, edge functions exempt. RLS SELECT-own with the cached subselect, service-role writes only. Tokens and secrets in Vault, never to the browser, never logged, never committed. Browser is read-only on all collected data. Migrations append-only, cloud-only, idempotent, types committed together, applied before the PR. Collected content is untrusted; shield it before any agent step. Content never leaves the boundary, embeddings included.

---

## Open decisions still pending

1. In-boundary embedding model and dimension. Confirmed in Epic 06 before the column migration. Candidate: Supabase `gte-small`, 384 dimensions.
2. OCR worker host for scanned PDFs. Deferred behind the Epic 05 queue. Decide when a client corpus exists and the in-boundary host and compliance review are scoped.
3. Schema standardization with Cloee.
