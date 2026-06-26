# Epic 04 Design: drive-collector

**Status:** Rev 5 — post Codex plan review v4 (RPC-only write path made explicit; delete/reset status-checked; reconnect provider-mismatch guard; RPC payload chunking; Content-Length pre-check). v1–v3 findings resolved in Rev 2–4.  
**Date:** 2026-06-26  
**Builder base branch:** `feature/epic-03-oauth-lifecycle` (stacked; merges when Epic 03 lands in `test`)  
**Build branch:** `feature/epic-04-drive-collector`

## Phase 0 gate (verify before any implementation)

Before implementing **any** Epic 04 work unit — the `documents` composite FK (EU-04-1), the `lifecycle_rpcs_v5` purge extension (EU-04-2), and the callback provider/scope changes (EU-04-6) all depend on Epic 03 schema state, not just the OAuth units — confirm Epic 03 is fully present and applied:

1. `npx supabase migration list --linked` shows in the Remote column: `lifecycle_version`, `add_provider_unique_key`, `vault_delete_secret`, `lifecycle_rpcs`, `lifecycle_rpcs_v2`, `drop_old_unique_key`, `fix_collect_messages_label_ids`, `lifecycle_rpcs_v3`.
2. `connected_accounts` has `UNIQUE(user_id, provider, email_address)` and NOT the old `UNIQUE(user_id, email_address)`.
3. `connected_accounts` has the `lifecycle_version` column.
4. If the builder is stacked on `feature/epic-03-oauth-lifecycle` (not yet merged to `test`), confirm that branch is the base. If Epic 03 has merged to `test`, rebase onto `test`.

If any check fails, STOP — Epic 04 cannot proceed until Epic 03 is in Remote.

---

## Goals

1. Connect Google Drive accounts via OAuth (`drive.readonly` scope) using the existing shared callback, reusing the provider-aware unique key from Epic 03.
2. Collect file metadata and text content for Google Workspace files and small native text files. Binary files (Word, Excel, PDF) stored as metadata-only with `content_status = 'needs_processing'` for Epic 05.
3. Surface collected files in a `/documents` viewer mirroring the `/emails` two-pane layout.
4. Reuse the Epic 03 lifecycle (disconnect/delete) for Drive accounts; extend the purge operation to also delete documents.
5. Personal Drive only. Shared Drives deferred.

---

## Decisions resolved

**Open question 1 — Drive scope set:**  
Include `openid email https://www.googleapis.com/auth/drive.readonly`. The callback's userinfo lookup derives the connection email the same way as Gmail. `drive.readonly` gives read access to all files and metadata; no send or write scopes.

**Open question 2 — Personal Drive only:**  
Personal Drive only. Shared Drives (Team Drives) deferred; the API path differs and adds complexity. Add `driveId` filter exclusion to the collector query.

**Open question 3 — Separate `/documents` route:**  
Separate `/documents` route. A combined sources tab would require refactoring `EmailPage` layout; that refactor is a future concern. The separate route keeps Epic 04 isolated and shippable.

**Open question 4 — Epic 04 does not enqueue Epic 05 jobs:**  
Confirmed. Epic 04 stores `content_status = 'needs_processing'` for binary files and stops there. Epic 05 owns the producer that scans `documents` for unprocessed rows and enqueues jobs.

**Additional decisions:**

**Provider value:** `'google_drive'`. Distinct from `'google'` (Gmail) so the provider-aware unique key `UNIQUE(user_id, provider, email_address)` allows a user to connect the same Google email address as both Gmail and Drive simultaneously.

**Callback reuse:** Modify `google-oauth-callback` to use `statePayload.provider ?? 'google'` for the `provider` column rather than the hardcoded `'google'`. Also add optional `redirect_path` to the state JWT so Drive OAuth can redirect to `/documents` on success instead of `/accounts`.

**Separate initiate function:** `google-drive-oauth-initiate` (new function). Symmetric with `google-oauth-initiate`. Sets `provider: 'google_drive'` and `redirect_path: '/documents'` in the signed state. Follows same nonce, signed state JWT pattern.

**Drive sync model:** Mirrors Gmail. `backfill_complete`, `backfill_page_token`, `sync_cursor` columns reused with Drive semantics:
- Backfill: Drive Files API (`/files?q=trashed=false&pageSize=100&pageToken=...`)
- Incremental: Drive Changes API (`/changes?pageToken=<sync_cursor>`)
- `backfill_start_history_id` not applicable to Drive — set to `NULL` always.

**Documents collector writes — advisory-lock RPC (Codex v2/v3 critical):** A non-atomic `status='active'` re-check followed by a separate upsert is a TOCTOU race: a `lifecycle_disconnect(..., purge=true)` can delete documents in the window between the check and the upsert, and the collector then re-inserts purged PII. This is the identical race Epic 03 fixed for messages with `collect_account_messages`. Mirror that exactly with a `collect_account_documents` RPC (Migration `documents_collect_rpc`): `SECURITY DEFINER`, takes `pg_advisory_xact_lock(hashtext(p_account_id::text))`, re-checks `status='active'` **inside the same transaction**, upserts the page's documents, and writes the cursor/backfill state — all atomic. The collector calls this RPC for every page write instead of direct `.upsert()`. REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only. Deletions (removed/trashed files, 410 purge) also go through a locked RPC path (`delete_account_documents(p_account_id, p_file_ids[])` and the purge inside `lifecycle_disconnect`, which already holds the same advisory lock from Epic 03).

**Purge extension:** Update `lifecycle_disconnect` (via `lifecycle_rpcs_v5` migration) to also execute `DELETE FROM documents WHERE connected_account_id = p_account_id` when `p_purge = true`. Drive accounts will be shown in `AccountCard` alongside Gmail accounts and share the same disconnect/delete UI. The `documents` table FK is `ON DELETE CASCADE`, so `lifecycle_delete` (which deletes the `connected_accounts` row) already cascades to documents automatically.

**Content extraction size limit:** Fetch text content for native text files only if size ≤ 500 KB. Larger native text files stored as `needs_processing`. This prevents edge-function memory exhaustion.

**`provider.ts` update:** Add `'google_drive'` to the `Provider` union.

---

## Safety rules compliance

1. **Tokens server-side only.** Drive OAuth tokens stored in Vault keyed by `account.id` (same as Gmail). Never returned to browser, never logged.
2. **Browser read-only on documents.** No `authenticated` INSERT/UPDATE/DELETE policy on `documents`. Collector writes under service role.
3. **PII — no content to external models.** Drive file text stored in Supabase only. Not sent to any external model or third party.
4. **Secrets never in git.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` stay in Vault and `.env`. Not committed.
5. **Collected content is untrusted.** Drive file content will eventually feed Epic 07 RAG; prompt injection shielding required at that step. Not built here; noted.

---

## Data model

### Table: `documents`

```sql
CREATE TABLE IF NOT EXISTS documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id  uuid NOT NULL,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  drive_file_id         text NOT NULL,
  name                  text NOT NULL,
  mime_type             text NOT NULL,
  web_view_link         text,
  size_bytes            bigint,
  drive_modified_time   timestamptz,
  text_content          text,
  content_status        text NOT NULL DEFAULT 'extracted'
                        CONSTRAINT documents_content_status_check
                        CHECK (content_status IN ('extracted', 'needs_processing', 'needs_ocr', 'skipped')),
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Composite FK (mirrors messages_user_fk fix): a document's (user_id, account)
  -- pair MUST match a real (user_id, id) pair in connected_accounts. This makes it
  -- impossible for the service role to write a document whose user_id doesn't own
  -- the account, closing the cross-user exposure hole. ON DELETE CASCADE so deleting
  -- the account (lifecycle_delete) removes its documents.
  CONSTRAINT documents_user_account_fk
    FOREIGN KEY (user_id, connected_account_id)
    REFERENCES connected_accounts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT documents_account_file_unique UNIQUE (connected_account_id, drive_file_id)
);
```

> **Note on the composite FK:** The `connected_accounts_user_id_id_key UNIQUE (user_id, id)` constraint already exists (added by `20260618000002_messages_user_fk.sql` for the identical `messages` fix). This composite FK target resolves against it. The single-column FK to `connected_accounts(id)` is dropped in favor of this composite FK — it still enforces account existence and adds the user_id integrity guarantee. Verified present 2026-06-26.

**content_status values:**
- `'extracted'` — text_content is populated (Workspace files or small native text)
- `'needs_processing'` — binary file (Word, Excel, PDF), Epic 05 will convert
- `'needs_ocr'` — scanned/image-only PDF (future Epic 05 OCR path)
- `'skipped'` — file type with no useful extraction (images, videos, audio, Google Forms)

**RLS:**
```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own documents"
  ON documents FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);
```

No INSERT/UPDATE/DELETE for `authenticated`. Collector writes under service role.

**Indexes:**
```sql
CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents (user_id);
CREATE INDEX IF NOT EXISTS documents_account_id_idx ON documents (connected_account_id);
-- UI lists sort by drive_modified_time DESC NULLS LAST — index ordering MUST match
-- the query's NULLS ordering or Postgres won't use it for the sort (Codex v1 #8, v2 #5)
CREATE INDEX IF NOT EXISTS documents_user_id_modified_idx
  ON documents (user_id, drive_modified_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS documents_user_account_modified_idx
  ON documents (user_id, connected_account_id, drive_modified_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS documents_content_status_idx
  ON documents (content_status) WHERE content_status != 'extracted';
```

### `connected_accounts` — no new columns

All required columns (`provider`, `lifecycle_version`, `backfill_complete`, `backfill_page_token`, `sync_cursor`, `status`) were added in Epic 03. Drive reuses them with Drive semantics.

### `src/types/provider.ts`

```typescript
export type Provider = 'google' | 'google_drive' | 'microsoft' | 'slack'
```

---

## Migrations (in deployment order)

### Migration 1 — `documents_table`

Creates `documents` table with RLS and indexes. See data model above. Idempotent (`IF NOT EXISTS`, `IF NOT EXISTS` on policies via DO block).

**Self-repair guard (Codex v2 #2):** Because `documents` is new, `CREATE TABLE IF NOT EXISTS` is normally enough — but if a partial/earlier `documents` table exists (e.g. from an aborted run with the old single-column FK), wrap a DO-block that drops any FK named `documents_connected_account_id_fkey` and ensures `documents_user_account_fk` exists and is validated:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_name='documents' AND constraint_name='documents_connected_account_id_fkey') THEN
    ALTER TABLE documents DROP CONSTRAINT documents_connected_account_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name='documents' AND constraint_name='documents_user_account_fk') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_user_account_fk
      FOREIGN KEY (user_id, connected_account_id)
      REFERENCES connected_accounts(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;
```

### Migration 2 — `lifecycle_rpcs_v5`

Extends `lifecycle_disconnect` to purge documents when `p_purge = true`:

```sql
CREATE OR REPLACE FUNCTION lifecycle_disconnect(
  p_account_id uuid,
  p_user_id uuid,
  p_purge boolean,
  p_expected_version integer
) RETURNS boolean ...
AS $$
...
  IF p_purge THEN
    DELETE FROM messages WHERE connected_account_id = p_account_id;
    DELETE FROM documents WHERE connected_account_id = p_account_id;  -- NEW
  END IF;
...
$$;
```

Full function body is identical to `lifecycle_rpcs_v3` except for the added documents purge. Same REVOKE/GRANT pattern.

### Migration 3 — `documents_collect_rpc`

Atomic, advisory-locked document upsert + cursor write, mirroring `collect_account_messages` (Codex v3 critical). Closes the purge/collection TOCTOU race.

```sql
CREATE OR REPLACE FUNCTION collect_account_documents(
  p_account_id uuid,
  p_documents jsonb,           -- array of document rows to upsert
  p_backfill_complete boolean, -- null = leave unchanged
  p_backfill_page_token text,  -- null = leave unchanged (sentinel handled in body)
  p_sync_cursor text           -- null = leave unchanged (sentinel handled in body)
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_doc jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  -- Account must still be active inside this transaction, else skip (purge/disconnect raced)
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
    RETURN;
  END IF;

  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO documents (
      connected_account_id, user_id, drive_file_id, name, mime_type,
      web_view_link, size_bytes, drive_modified_time, text_content, content_status,
      fetched_at, updated_at
    )
    SELECT
      p_account_id,
      (v_doc->>'user_id')::uuid,
      v_doc->>'drive_file_id',
      v_doc->>'name',
      v_doc->>'mime_type',
      v_doc->>'web_view_link',
      NULLIF(v_doc->>'size_bytes','')::bigint,
      NULLIF(v_doc->>'drive_modified_time','')::timestamptz,
      v_doc->>'text_content',
      v_doc->>'content_status',
      now(), now()
    ON CONFLICT (connected_account_id, drive_file_id) DO UPDATE SET
      name = EXCLUDED.name,
      mime_type = EXCLUDED.mime_type,
      web_view_link = EXCLUDED.web_view_link,
      size_bytes = EXCLUDED.size_bytes,
      drive_modified_time = EXCLUDED.drive_modified_time,
      text_content = EXCLUDED.text_content,
      content_status = EXCLUDED.content_status,
      updated_at = now();
  END LOOP;

  -- Cursor / backfill state writes, atomic with the upserts above.
  -- Use a sentinel ('__unchanged__') so the collector can leave a column alone.
  UPDATE connected_accounts SET
    backfill_complete   = COALESCE(p_backfill_complete, backfill_complete),
    backfill_page_token = CASE WHEN p_backfill_page_token = '__unchanged__' THEN backfill_page_token
                               ELSE p_backfill_page_token END,
    sync_cursor         = CASE WHEN p_sync_cursor = '__unchanged__' THEN sync_cursor
                               ELSE p_sync_cursor END,
    last_synced_at = now(),
    updated_at = now()
  WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM anon;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) TO service_role;

-- Locked deletion path for removed/trashed files
CREATE OR REPLACE FUNCTION delete_account_documents(
  p_account_id uuid,
  p_file_ids text[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- Only act while the account is active. If the user disconnected with purge=false
  -- (status='revoked'), a stale in-flight collector must NOT delete kept documents (Codex v4).
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
    RETURN;
  END IF;
  DELETE FROM documents
    WHERE connected_account_id = p_account_id
      AND drive_file_id = ANY(p_file_ids);
END;
$$;

REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION delete_account_documents(uuid, text[]) TO service_role;

-- Purge-all + backfill reset under the lock, for the 410-Gone recovery path
CREATE OR REPLACE FUNCTION reset_account_documents(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- Only reset while active — a disconnected account's data must be left to the
  -- lifecycle path, not wiped by a stale collector (Codex v4).
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
    RETURN;
  END IF;
  DELETE FROM documents WHERE connected_account_id = p_account_id;
  UPDATE connected_accounts
    SET backfill_complete = false, sync_cursor = NULL, backfill_page_token = NULL, updated_at = now()
    WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM anon;
REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_account_documents(uuid) TO service_role;
```

The collector passes `'__unchanged__'` for `p_backfill_page_token`/`p_sync_cursor` when a given write should not touch that column (e.g. an incremental page write leaves `backfill_page_token` alone).

### Migration 4 — `drive_cron`

```sql
DO $$
BEGIN
  PERFORM cron.unschedule('collect-drive-every-5min');
EXCEPTION WHEN others THEN
  NULL;
END $$;

SELECT cron.schedule(
  'collect-drive-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-drive-collector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
```

---

## Edge function specs

### Modified: `gmail-collector` (CRITICAL — must deploy before any Drive account exists)

The current `gmail-collector` fetches **all** active accounts without a provider filter:
```typescript
.from('connected_accounts').select(...).eq('status', 'active')
```
Once Drive accounts exist with `status = 'active'`, this collector would pull a Drive account's refresh token from Vault and try it against the Gmail API — wasting calls and flipping the Drive account to `error` on failure (cross-talk).

**Fix:** add `.eq('provider', 'google')` to the account query:
```typescript
.from('connected_accounts').select(...).eq('status', 'active').eq('provider', 'google')
```

**Deployment ordering consequence:** this modified `gmail-collector` MUST be deployed before Migration 3 (`drive_cron`) and before any Drive account can be connected. It is the first deploy step.

**Test:** regression test asserting the query includes the provider filter (or an integration-style test that a `google_drive` account is not picked up by the Gmail collector).

### Modified: `google-oauth-callback`

**Change 1 — Provider whitelist + provider-driven scope mapping (Codex v1 #6):**

The callback currently hardcodes both `provider: 'google'` and the Gmail `granted_scopes` string. Replace with a validated provider and a scope map so a Drive connection records the correct granted scopes:

```typescript
const PROVIDER_SCOPES: Record<string, string> = {
  google:        'openid email https://www.googleapis.com/auth/gmail.readonly',
  google_drive:  'openid email https://www.googleapis.com/auth/drive.readonly',
}

const provider = statePayload.provider ?? 'google'
if (!(provider in PROVIDER_SCOPES)) {
  // Reject unknown providers rather than writing an unconstrained row
  console.error('Unknown provider in state JWT')
  throw new Error('invalid_provider')
}
const grantedScopes = PROVIDER_SCOPES[provider]
// Use `provider` and `grantedScopes` in both the new-connection upsert
// AND the reconnect update (reconnect currently hardcodes the Gmail scope string).
```

Apply `provider` to the `onConflict: 'user_id,provider,email_address'` upsert and `grantedScopes` to `granted_scopes` in both the new-connection and reconnect paths.

**Change 2 — Add redirect_path to state, whitelisted (Codex v1 #6):**

Add `redirect_path?: string` to `StatePayload`. Whitelist against known app paths — never redirect to an arbitrary attacker-supplied path (open-redirect guard), even though the state is HMAC-signed:

```typescript
const ALLOWED_REDIRECTS = new Set(['/accounts', '/documents'])
const requested = statePayload.redirect_path ?? '/accounts'
const redirectPath = ALLOWED_REDIRECTS.has(requested) ? requested : '/accounts'
return Response.redirect(`${siteUrl}${redirectPath}`, 302)
```

**Change 3 — Reconnect path provider guard:**

The reconnect path fetches the existing account by ID. Fetch its `provider` and **reject a provider mismatch** between the state JWT and the existing row (Codex v4): if `statePayload.provider ?? 'google'` ≠ `existingAccount.provider`, throw `provider_mismatch` and abort (revoke the freshly issued token via the existing abort path). This prevents a Gmail reconnect from overwriting a Drive account's tokens/scopes or vice-versa. Then derive `granted_scopes` from the row's provider via `PROVIDER_SCOPES` (it is currently hardcoded to Gmail).

**Backward compatibility:** `statePayload.provider` optional → defaults to `'google'`. `redirect_path` optional → defaults to `'/accounts'`. Existing Gmail initiations keep working unchanged.

**JWT interface additions:**
```typescript
interface StatePayload {
  user_id: string
  nonce: string
  exp: number
  reconnect_account_id?: string
  provider?: string        // 'google' | 'google_drive' — defaults to 'google'
  redirect_path?: string   // e.g. '/documents' — defaults to '/accounts'
}
```

### New: `google-drive-oauth-initiate`

Symmetric with `google-oauth-initiate`. Key differences:

- **Scopes:** `openid email https://www.googleapis.com/auth/drive.readonly`
- **State payload:** includes `provider: 'google_drive'` and `redirect_path: '/documents'`
- **Reconnect support:** same pattern — accepts `{ reconnect: true, accountId }` in POST body; embeds `reconnect_account_id` in state
- **Account ownership check on reconnect:** fetches account, verifies `provider = 'google_drive'` and `user_id = user.id`
- **verify_jwt:** `true` (same as `google-oauth-initiate`)

Same nonce + state JWT signing. Same CORS headers.

```typescript
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

const statePayload = {
  user_id: user.id,
  nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  provider: 'google_drive',
  redirect_path: '/documents',
  ...(reconnectAccountId ? { reconnect_account_id: reconnectAccountId } : {}),
}
```

### New: `google-drive-collector`

**Auth:** Same `CRON_SECRET` bearer token pattern as `gmail-collector`. `verify_jwt: false`.

**Env vars used:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`.

**Main loop:**

```
1. Fetch active Drive accounts:
   SELECT ... FROM connected_accounts
   WHERE provider = 'google_drive' AND status = 'active'

2. For each account:
   a. Get refresh token from Vault (get_vault_secret)
   b. Refresh access token (same token refresh path as gmail-collector)
   c. On invalid_grant / token_revoked → update status = 'error', continue
   d. If !backfill_complete → BACKFILL PATH
   e. Else → INCREMENTAL PATH (Drive Changes API)
```

**Backfill path (Codex v1 #4 — capture start token BEFORE page 1):**

The Drive Changes start token must be captured *before* the first Files page so that any file created/modified/deleted *during* the multi-run backfill is replayed by the incremental Changes pass afterward. This mirrors the Gmail `backfill_start_history_id` pattern. Reuse the `sync_cursor` column to stash the pre-backfill start token during backfill (it is not used for incremental until backfill completes).

```
1. If sync_cursor IS NULL (first backfill run for this account):
     GET /drive/v3/changes/startPageToken   → store result in sync_cursor immediately
     (this is the "drain from here after backfill" token, captured before page 1)

2. Loop up to MAX_PAGES_PER_RUN (4) pages:
   GET /drive/v3/files
     ?q=trashed=false
     &fields=nextPageToken,files(id,name,mimeType,webViewLink,size,modifiedTime)
     &pageSize=25            (DRIVE_PAGE_SIZE — whole-page processing fits wall-clock)
     &pageToken=<backfill_page_token if set>
     &corpora=user            (owned + shared-with-me; Shared/Team Drives excluded — neither
                               includeItemsFromAllDrives nor supportsAllDrives is set)

   On 400 with reason 'invalidValue'/'pageTokenInvalid' (expired files.list page token, Codex v3):
     clear backfill_page_token = null and restart backfill pagination from page 1 next run; break

   For each file in the page: classify MIME type → extract or mark → build doc row
   (process the WHOLE page; collect rows into a pageDocs[] array)

   Persist the page ATOMICALLY via the RPC (re-checks status='active' under advisory lock):
     If response has nextPageToken:
       collect_account_documents(account.id, pageDocs, NULL, nextPageToken, '__unchanged__')
       if pages-this-run >= MAX_PAGES_PER_RUN: stop (resume next tick); else continue loop
     Else (final page):
       collect_account_documents(account.id, pageDocs, true /*backfill_complete*/, NULL, '__unchanged__')
       (sync_cursor already holds the pre-backfill start token from step 1 — pass '__unchanged__')
       break
```

Note `backfill_start_history_id` is NOT used for Drive — the pre-backfill token lives in `sync_cursor` from the start. `backfill_start_history_id` stays NULL.

**Incremental path (Codex v1 #3 — must paginate Changes, store newStartPageToken only at end):**

The Drive Changes API returns `nextPageToken` while more change pages remain, and returns `newStartPageToken` only on the **final** page. We must loop until there is no `nextPageToken`, applying each page, and persist `newStartPageToken` as the new `sync_cursor` only after the last page. `fileId` must be in the field mask to handle removals.

```
let pageToken = account.sync_cursor
let pagesThisRun = 0
loop:
  GET /drive/v3/changes
    ?pageToken=<pageToken>
    &fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,webViewLink,size,modifiedTime,trashed))
    &pageSize=25            (DRIVE_PAGE_SIZE)
    &includeRemoved=true
    # corpus aligned with backfill: do NOT set restrictToMyDrive — changes then covers the
    # same owned + shared-with-me set that files.list corpora=user returns, so shared-with-me
    # rows don't go stale (Codex v3). Shared/Team Drives excluded in both (no allDrives flags).
    # file(...,trashed) is in the mask — Drive omits trashed unless requested (Codex v2 #4)

  On 410 Gone (token expired): the cursor is unrecoverable and we may have missed deletions.
    reset_account_documents(account.id)   # locked: purges docs + resets backfill state (Codex v2 #3, v3)
    then break (next run rebuilds from scratch; pre-backfill start token re-captured fresh)

  Process the WHOLE page; partition changes into:
    - removedIds[]  ← changes where removed === true OR file.trashed === true (collect change.fileId)
    - upsertDocs[]  ← changes with a live file (classify + build row)

  Persist the page atomically:
    if removedIds: delete_account_documents(account.id, removedIds)   # locked
    If response.nextPageToken:
      pageToken = response.nextPageToken
      collect_account_documents(account.id, upsertDocs, NULL, '__unchanged__', pageToken)  # cursor = next page token
      pagesThisRun++
      if pagesThisRun >= MAX_PAGES_PER_RUN: break
      continue
    Else:
      collect_account_documents(account.id, upsertDocs, NULL, '__unchanged__', response.newStartPageToken)
      break
```

Checkpointing is page-aligned: `sync_cursor` always holds a valid `pageToken` (either the next `nextPageToken` or the terminal `newStartPageToken`). Capping at `MAX_PAGES_PER_RUN` is safe because we only ever persist a token after a whole page is applied.

**MIME type classification:**

```typescript
const WORKSPACE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

const NATIVE_TEXT_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'text/csv',
  'text/javascript', 'application/json', 'application/xml', 'text/xml',
])

const BINARY_PROCESSING_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',// pptx
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
])

function classifyFile(mimeType: string, sizeBytes: number | null): {
  action: 'export_workspace' | 'download_text' | 'needs_processing' | 'needs_ocr' | 'skip'
  exportMimeType?: string
} {
  if (WORKSPACE_EXPORTS[mimeType]) {
    return { action: 'export_workspace', exportMimeType: WORKSPACE_EXPORTS[mimeType] }
  }
  if (NATIVE_TEXT_TYPES.has(mimeType)) {
    if (sizeBytes !== null && sizeBytes > 500_000) return { action: 'needs_processing' }
    return { action: 'download_text' }
  }
  if (BINARY_PROCESSING_TYPES.has(mimeType)) {
    // TODO: distinguish scanned PDFs (needs_ocr) from text-layer PDFs (needs_processing)
    // For now, all PDFs and binary formats → needs_processing; Epic 05 refines this
    return { action: 'needs_processing' }
  }
  return { action: 'skip' }  // images, video, audio, forms, etc.
}
```

**Content extraction:**

For `export_workspace`: `GET /drive/v3/files/{id}/export?mimeType={exportMimeType}`  
For `download_text`: `GET /drive/v3/files/{id}?alt=media`  
Both return the text body directly. Truncate at 500 KB if the export exceeds that.

**Rate-limit handling (Codex v1 #10):** Drive enforces per-user quota units; export/download calls can 403 (`rateLimitExceeded`/`userRateLimitExceeded`) or 429. Wrap every Drive fetch in a bounded retry with truncated exponential backoff:

```typescript
async function driveFetch(url, init, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.status !== 429 && res.status !== 403) return res
    if (attempt >= maxRetries) return res   // give up, caller treats as error
    const backoffMs = Math.min(1000 * 2 ** attempt, 8000)  // 1s, 2s, 4s (cap 8s)
    await new Promise(r => setTimeout(r, backoffMs))
  }
}
```

(403 is retried only when the body/reason indicates a rate-limit reason; a 403 for `insufficientPermissions` should not retry — inspect `error.errors[0].reason` and only back off for `rateLimitExceeded` / `userRateLimitExceeded`.)

**Per-run caps — checkpoint ONLY at page boundaries (Codex v2 critical):** Drive page tokens resume at page boundaries, not item offsets, so we must never stop mid-page. Bound the run by *pages*, not files:

- Set Drive `pageSize` small enough that one full page of content extractions fits the edge-function wall-clock: `DRIVE_PAGE_SIZE = 25` for both Files (backfill) and Changes (incremental).
- Process **whole pages only**. After each fully-processed page, persist the page token (`backfill_page_token` for backfill, or the `nextPageToken` as `sync_cursor` for incremental) — these tokens are valid resume points.
- Cap at `MAX_PAGES_PER_RUN = 4` pages per account per run (≈100 files/run at pageSize 25). If the cap is hit, persist the next page token and resume on the next cron tick. Never persist a token mid-page; never partially process a page and checkpoint.

This removes the mid-page-skip/reprocess-forever hazard: a persisted token always points exactly at the first unprocessed page.

**Error counters carry no PII:** log only counts and Drive error reasons, never file names or content.

**Bounded content read (Codex v2 #7):** Do not call `await res.text()` on an unbounded export — a huge Workspace export would spike memory. Read the response body through a bounded reader that cancels the stream once 500 KB have been accumulated:

```typescript
async function readBounded(res: Response, maxBytes = 500_000): Promise<string> {
  // Pre-check Content-Length: if the server declares a size far over the cap, don't even
  // buffer it — signal the caller to mark the file needs_processing instead (Codex v4).
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes * 10) {            // e.g. > 5 MB → too big to extract inline
    await res.body?.cancel()
    throw new Error('content_too_large')      // caller sets content_status='needs_processing'
  }
  const reader = res.body?.getReader()
  if (!reader) {
    // Deno's fetch always provides res.body; this fallback is defensive. Cap bytes before decode.
    const buf = new Uint8Array(await res.arrayBuffer())
    return new TextDecoder().decode(buf.subarray(0, maxBytes))
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    // Trim this chunk so the accumulated total never exceeds maxBytes
    const remaining = maxBytes - total
    const slice = value.length > remaining ? value.subarray(0, remaining) : value
    chunks.push(slice); total += slice.length
  }
  await reader.cancel()  // stop downloading once we have enough
  return new TextDecoder().decode(concat(chunks))
}
```

The byte cap is enforced *before* accumulation, so memory never exceeds `maxBytes` regardless of chunk sizes, and the fallback path reads an `ArrayBuffer` capped at decode time rather than buffering an unbounded string. Unit-test (Codex v2 #7): asserts it stops at the cap, trims an oversized final chunk, and cancels the stream.

**Document row shape (built per file, then passed to the `collect_account_documents` RPC — NEVER written via a direct `.from('documents').upsert()`; all writes go through the advisory-locked RPC, Codex v4):**

```typescript
// Build the row object only; the RPC performs the atomic, status-checked upsert.
const docRow = {
  user_id: account.user_id,
  drive_file_id: file.id,
  name: file.name,
  mime_type: file.mimeType,
  web_view_link: file.webViewLink ?? null,
  size_bytes: file.size ? String(parseInt(file.size)) : null,  // stringified for jsonb
  drive_modified_time: file.modifiedTime ?? null,
  text_content: textContent ?? null,
  content_status: contentStatus,
}
// pageDocs.push(docRow) — then once per page:
//   await supabaseAdmin.rpc('collect_account_documents', {
//     p_account_id: account.id, p_documents: pageDocs,
//     p_backfill_complete: ..., p_backfill_page_token: ..., p_sync_cursor: ...,
//   })
```

There is **no** direct `supabaseAdmin.from('documents').upsert(...)` anywhere in the collector — that would bypass the advisory lock and reopen the purge race. The RPC is the single write path.

**RPC payload chunking (Codex v4):** a 25-doc page with 500 KB text each is ~12.5 MB of JSON — over typical request limits. Split each page's `pageDocs` into sub-batches of at most `RPC_DOC_BATCH = 5` docs (and/or a ~3 MB serialized ceiling) and call `collect_account_documents` once per sub-batch with `p_backfill_page_token='__unchanged__'`, `p_sync_cursor='__unchanged__'`. Only the **final** sub-batch of the page carries the real cursor/backfill-state advance, so the cursor moves only after every doc on the page is durably written. If an earlier sub-batch fails, the cursor is not advanced and the page is retried next run (upserts are idempotent on `(connected_account_id, drive_file_id)`).

**Error handling:** Per-file try/catch (skip and count errors, same as gmail-collector). Return `{ processed, errors, accounts: accounts?.length }`.

**Token safety:** Access token never stored. Refresh token read from Vault, never logged. File content never sent externally.

---

## Service layer: `src/services/documents.service.ts`

Mirror `messages.service.ts` exactly — including its `.range()`-based pagination — so the Drive viewer behaves like the email viewer (Codex v1 #8).

```typescript
const PAGE_SIZE = 50

// Paginated list, ordered by drive_modified_time DESC NULLS LAST to match the UI.
// page is 0-based; uses .range(page*PAGE_SIZE, page*PAGE_SIZE + PAGE_SIZE - 1)
export async function listDocuments(params: {
  page: number
  accountId?: string
}): Promise<{ documents: Document[]; hasMore: boolean }>

// Get a single document by ID
export async function getDocument(id: string): Promise<Document | null>

// Initiate Drive OAuth — performs window.location redirect itself (same shape as
// initiateOAuth in accounts.service.ts), NOT returning { url } (Codex v1 #7).
export async function initiateGoogleDriveOAuth(params?: {
  reconnect?: boolean
  accountId?: string
}): Promise<void>
```

`listDocuments` selects from `documents` ordered by `drive_modified_time DESC NULLS LAST`, matching the `documents_user_id_modified_idx` index and the UI sort. `hasMore` is computed by requesting `PAGE_SIZE + 1` or by comparing the returned count to `PAGE_SIZE` (same technique as `messages.service.ts`).

`initiateGoogleDriveOAuth` calls the `google-drive-oauth-initiate` edge function with the user's JWT bearer token, then performs the redirect itself (`window.location.href = url`) — identical control flow to `initiateOAuth`, so the two connect buttons behave the same way.

---

## Hooks: `src/hooks/useDocuments.ts`

Mirror `useMessages.ts` — use `useInfiniteQuery` for the list so scrolling loads more pages (Codex v1 #8):

```typescript
// Infinite paginated list, mirrors useMessages
export function useDocuments(params?: { accountId?: string }): UseInfiniteQueryResult<...>

// Single document detail query
export function useDocument(id: string | null): UseQueryResult<Document | null>
```

Query keys: `['documents', accountId ?? 'all']` / `['document', id]`  
`getNextPageParam` returns `lastPage.hasMore ? pages.length : undefined`.  
Same `staleTime` / `refetchInterval` polling pattern as `useMessages` (React Query polling, no realtime).

---

## Frontend components

### `src/components/documents/DocumentsPage.tsx`

Route: `/documents`  
Two-pane layout mirroring `EmailPage`:

- **Left pane (`DocumentList`):** list of documents, sorted by `drive_modified_time DESC`
  - Each row: file name, MIME type icon/label, modified date, `content_status` badge for non-extracted files
  - Click → sets selected document
- **Right pane (`DocumentDetail`):** 
  - If no document selected: `EmptyState` "Select a file to view its content"
  - If `content_status = 'extracted'`: render `text_content` **as plain text only** — in a scrollable `<pre>` or text node. **Never** `dangerouslySetInnerHTML`, never render as HTML, even for `text/html` source files. Collected content is untrusted (safety rule 5); rendering it as markup would be a stored-XSS vector. (Codex v1 #11)
  - If `content_status = 'needs_processing'`: message "Content extraction pending (Epic 05)"
  - If `content_status = 'needs_ocr'`: message "OCR required — this file contains scanned content"
  - If `content_status = 'skipped'`: message "Content not available for this file type"
  - Show file metadata: name, MIME type, size, modified date, link to Drive (`web_view_link`). The Drive link MUST use `rel="noopener noreferrer"` and `target="_blank"`. (Codex v1 #11)

**Empty state (no Drive accounts connected):**  
`EmptyState` with "No Drive accounts connected" message and "Connect Google Drive" button that calls `initiateGoogleDriveOAuth()`.

**Loading/error states:** Same pattern as `EmailPage`.

### `src/components/documents/DocumentList.tsx`

Props: `documents: Document[]`, `selectedId: string | null`, `onSelect: (id: string) => void`  
Mirrors `MessageList`.

### `src/components/documents/DocumentDetail.tsx`

Props: `document: Document | null`, `isLoading: boolean`  
Mirrors `MessageDetail`.

### `src/components/accounts/AccountCard.tsx` — Drive account variant

The existing `AccountCard` receives an account from `useAccounts`. Drive accounts (`provider = 'google_drive'`) should render with a Drive icon and slightly different label ("Google Drive · email@example.com"). All lifecycle buttons (Disconnect, Delete, Reconnect) work via the same services — no code change needed beyond the display label/icon.

Update `AccountCard` to render Drive accounts correctly:
- Show "Google Drive" label when `account.provider === 'google_drive'`
- Show a Drive icon (SVG or emoji) instead of the Gmail icon
- **Reconnect must branch by provider (Codex v1 #7):** Epic 03's `AccountCard` calls reconnect hardcoded to Gmail. Change it to route by `account.provider`: a `google` account reconnects via the Gmail initiate path; a `google_drive` account reconnects via `initiateGoogleDriveOAuth({ reconnect: true, accountId: account.id })`. Same for any provider-specific delete/disconnect wiring — select the service call by `account.provider`.
- Status badges and the disconnect/delete modals are provider-agnostic and unchanged.

### `src/components/accounts/AccountsPage.tsx` — Connect Drive button

Add a "Connect Google Drive" button alongside the existing "Connect Gmail" button. On click, calls `documents.service.initiateGoogleDriveOAuth()`. Same optimistic disable-while-pending pattern.

### Route

```typescript
// In src/App.tsx or router
<Route path="/documents" element={<DocumentsPage />} />
```

Add "Documents" nav link in the sidebar/nav alongside "Emails".

### SCSS

- `DocumentsPage.module.scss` — mirrors `EmailPage.module.scss`
- `DocumentList.module.scss` — mirrors `MessageList.module.scss`
- `DocumentDetail.module.scss` — mirrors `MessageDetail.module.scss`

Use existing design tokens. No new token values.

---

## Tests

### `src/services/documents.service.test.ts`

- `listDocuments` calls correct Supabase query (ordered `drive_modified_time DESC NULLS LAST`, `.range()` pagination), returns typed rows + `hasMore`
- `getDocument` handles not-found (returns null)
- `initiateGoogleDriveOAuth` calls the correct edge function and sets `window.location.href` to the returned URL (returns `Promise<void>`, does NOT return `{ url }`) — mock `window.location` (Codex v2 #6)
- Error propagation

### `src/components/documents/DocumentsPage.test.tsx`

- Renders empty state when no documents
- Renders document list when data present
- Selecting a document renders detail pane
- Shows "Content extraction pending" for `needs_processing` status

### `src/components/accounts/AccountCard.test.tsx` — update

- Renders "Google Drive" label for `provider === 'google_drive'`
- Reconnect on a `google_drive` account calls the Drive initiate path; reconnect on a `google` account calls the Gmail path (Codex v1 #7)
- All existing Gmail tests still pass

### Edge-function logic tests (Codex v1 #9)

The Deno edge functions can't run under Jest directly, but the **pure classification and parsing logic** must be extracted into testable TS modules (mirroring how `gmail-backfill.test.ts` tests pure backfill helpers) and unit-tested with mocked `fetch`:

- `classifyFile(mimeType, sizeBytes)` — table-driven test across every branch: Workspace doc/sheet/slides → export; native text under/over 500 KB → download/needs_processing; docx/xlsx/pdf → needs_processing; image/video → skip.
- Changes-API page reducer — given a sequence of pages with `nextPageToken` then a final page with `newStartPageToken`, asserts: all pages applied, removals delete by `fileId`, cursor advances to `newStartPageToken` only at the end (Codex v1 #3).
- 410-Gone handler — asserts the account is reset to re-enter backfill (Codex v1, incremental reset).
- Backoff helper — asserts `driveFetch` retries on 429 and on rate-limit-reason 403, gives up after `maxRetries`, and does NOT retry a non-rate-limit 403 (Codex v1 #10).
- `gmail-collector` provider filter — assert the account query restricts to `provider = 'google'` (Codex v1 #2).
- Callback state mapping — given a Drive state payload, asserts `provider='google_drive'`, `granted_scopes` = drive scope, and that an unknown provider is rejected; given a Gmail payload, asserts the unchanged Gmail behavior; `redirect_path` outside the whitelist falls back to `/accounts` (Codex v1 #6).

### Migration / RLS tests (Codex v1 #1, #9)

- The composite FK rejects an insert where `user_id` does not own `connected_account_id` (cross-user write denial).
- `authenticated` role cannot INSERT/UPDATE/DELETE `documents` (RLS write denial); can only SELECT own rows.
- `lifecycle_disconnect(..., p_purge=true)` deletes the account's documents; `p_purge=false` leaves them.
- `lifecycle_delete` cascade-deletes documents via the composite FK ON DELETE CASCADE.
- `collect_account_documents` skips all writes when the account is not `active` (purge-race no-op) and upserts + advances cursor when active.
- `delete_account_documents` removes only the listed file ids for the account; `reset_account_documents` purges all docs and resets backfill state.
- All three new RPCs are not executable by `anon`/`authenticated` (grant test), only `service_role`.

These run as SQL assertions against the linked project (or a migration-test harness), consistent with how the team verifies RLS.

---

## Deployment order

Corrected so that nothing can run against a half-deployed state (Codex v1 #2, #5). The cron job is scheduled **last**, after the collector it invokes is live and smoke-tested.

1. **Deploy `gmail-collector` (modified)** — adds `.eq('provider', 'google')`. Must land before any Drive account can exist, so the Gmail collector never grabs a Drive token. (Codex v1 #2)
2. **Migration 1** — `documents_table` (composite FK, RLS, indexes) → confirm Remote → `npm run gen:types`, commit types in the same commit.
3. **Migration 2** — `lifecycle_rpcs_v5` (purge documents) → confirm Remote.
4. **Migration 3** — `documents_collect_rpc` (`collect_account_documents`, `delete_account_documents`, `reset_account_documents`) → confirm Remote → `npm run gen:types`, commit types.
5. **Deploy `google-oauth-callback` (modified)** — provider whitelist, scope map, redirect whitelist. Backward-compatible (defaults to `'google'` / `/accounts`).
6. **Deploy `google-drive-oauth-initiate` (new).**
7. **Deploy `google-drive-collector` (new)** — calls the collect/delete/reset RPCs.
8. **Smoke-test the collector manually:** invoke `google-drive-collector` once with the `CRON_SECRET` bearer (no Drive account connected yet → expect `{processed:0, errors:0, accounts:0}`; then connect one Drive account and invoke again → expect it to begin backfill). Confirm no errors in logs.
9. **Migration 4** — `drive_cron` (schedule every 5 min) → confirm Remote. Scheduled only now that the collector is proven.
10. **Frontend** build + deploy (Connect Drive button, `/documents` route).

## Rollback runbook (Codex v1 #12)

If Epic 04 misbehaves in the demo environment, back out in this order without destroying collected data:

1. **Stop collection:** unschedule the cron job — `SELECT cron.unschedule('collect-drive-every-5min');` (idempotent; safe if already gone).
2. **Hide the entry point:** feature-flag or remove the "Connect Google Drive" button and the `/documents` nav link so users can't start new Drive connections.
3. **Revert the callback if needed:** redeploy the prior `google-oauth-callback` version (it's backward-compatible, so this is only needed if the new provider/scope logic itself is faulty). Same for `gmail-collector` — but note the provider filter is strictly safer, so keep it.
4. **Preserve data:** do NOT drop the `documents` table or delete rows on rollback — leave collected data in place. If specific bad rows must go, delete by `connected_account_id`, never a blanket wipe.
5. **Tokens:** only ever remove Drive Vault secrets through the lifecycle delete/disconnect path (which revokes at Google first). Never orphan or hand-delete a Vault secret.
6. **Migrations are append-only:** none of the three migrations are destructive to existing Gmail data. The `documents` table and the `lifecycle_rpcs_v5` purge-extension are additive; leaving them applied is harmless even with the feature disabled.

---

## GitHub issues

| # | Work unit | Notes |
|---|---|---|
| EU-04-0 | gmail-collector: add `.eq('provider','google')` | CRITICAL, deploy first (Codex #2) |
| EU-04-1 | Migration: documents table | Composite FK, RLS, modified-time indexes, idempotent (Codex #1, #8) |
| EU-04-2 | Migration: lifecycle_rpcs_v5 | Extend disconnect purge to documents |
| EU-04-2b | Migration: documents_collect_rpc | Advisory-locked collect/delete/reset RPCs (Codex v3 critical) |
| EU-04-3 | Migration: drive_cron | pg_cron job — scheduled LAST after collector smoke test (Codex #5) |
| EU-04-4 | types/provider.ts: add google_drive | Small frontend change |
| EU-04-5 | google-drive-oauth-initiate edge function | New, mirrors google-oauth-initiate, reconnect support |
| EU-04-6 | google-oauth-callback: provider whitelist + scope map + redirect whitelist | Backward-compatible mod (Codex #6) |
| EU-04-7 | google-drive-collector edge function | New; backfill with pre-captured start token, paginated Changes, backoff, per-run caps (Codex #3, #4, #10) |
| EU-04-8 | documents.service.ts | Service layer; `.range()` pagination, redirect like Gmail (Codex #7, #8) |
| EU-04-9 | useDocuments (infinite), useDocument hooks | React Query, mirror useMessages (Codex #8) |
| EU-04-10 | DocumentsPage + DocumentList + DocumentDetail | Two-pane viewer; plain-text render only, noopener links (Codex #11) |
| EU-04-11 | AccountsPage + AccountCard: Drive support | Connect Drive button + Drive label + provider-branched reconnect (Codex #7) |
| EU-04-12 | Router: /documents route + nav link | |
| EU-04-13 | Tests | Service, hook, component, edge-logic, RLS/migration tests (Codex #9) |
| EU-04-14 | npm run gen:types + commit | Paired with Migration 1 |

---

## Acceptance criteria

1. A user can click "Connect Google Drive" on the Accounts page and complete the OAuth flow (consent screen, Drive scope grant).
2. A Drive account appears in the Accounts page with a Drive label and all lifecycle buttons functional (disconnect, delete, reconnect).
3. The Drive collector runs every 5 minutes, collects file metadata and text for Google Workspace and small native text files, and stores them in `documents`.
4. `/documents` renders a two-pane view: file list on left, file content (or extraction-status message) on right.
5. Disconnecting a Drive account with purge=true removes all documents for that account.
6. Deleting a Drive account cascade-deletes all documents.
7. TypeScript strict mode passes, lint passes, all tests pass, all migrations in Remote column.
8. Tokens never logged or returned to browser. Browser has no INSERT/UPDATE/DELETE on `documents`.

---

## Open items / risks

1. **`drive.readonly` scope verification:** Google `drive.readonly` is a sensitive scope requiring app verification for public users. The app stays in Testing mode with test users added for the demo. Internal Workspace clients use domain-wide install (bypasses verification). No action needed before the demo.
2. **Drive API rate limits:** The Files API has a default quota of 1,000 requests per 100 seconds per user. The collector processes 100 files per page per run. For large Drives, the cron interval (5 min) provides natural backpressure. No special rate limit handling in MVP.
3. **Export size:** Google Docs export via `files.export` can return large text. Apply a 500 KB truncation cap in the collector.
4. **Changes API `startPageToken` expiry:** According to Google Docs, startPageTokens can expire. If the collector gets a 410 Gone on the incremental path, reset `backfill_complete = false` and `sync_cursor = null` to re-enter backfill (same pattern as Gmail 404 cursor reset).
