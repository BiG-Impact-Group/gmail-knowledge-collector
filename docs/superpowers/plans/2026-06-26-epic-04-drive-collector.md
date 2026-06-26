# Epic 04 Design: drive-collector

**Status:** Draft — pending Codex plan review  
**Date:** 2026-06-26  
**Builder base branch:** `feature/epic-03-oauth-lifecycle` (stacked; merges when Epic 03 lands in `test`)  
**Build branch:** `feature/epic-04-drive-collector`

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

**Documents collector writes:** Direct service-role writes (no advisory lock RPC). Drive files change less frequently than Gmail messages. If a lifecycle purge races with collection, the purge cascade will clean up the surviving rows on the next disconnect. Formal locking deferred to Epic 05 or later if needed.

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
  connected_account_id  uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
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
  CONSTRAINT documents_account_file_unique UNIQUE (connected_account_id, drive_file_id)
);
```

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
CREATE INDEX IF NOT EXISTS documents_user_id_created_at_idx ON documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_content_status_idx ON documents (content_status) WHERE content_status != 'extracted';
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

### Migration 3 — `drive_cron`

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

### Modified: `google-oauth-callback`

**Change 1 — Use provider from state JWT:**

Replace the hardcoded `provider: 'google'` in the new-connection upsert path with:
```typescript
const provider = statePayload.provider ?? 'google'
// Use `provider` in the upsert
```

**Change 2 — Add redirect_path to state:**

Add `redirect_path?: string` to `StatePayload` interface.  
In the callback, after successful OAuth:
```typescript
const redirectPath = statePayload.redirect_path ?? '/accounts'
return Response.redirect(`${siteUrl}${redirectPath}`, 302)
```

**Change 3 — Reconnect path provider guard:**

The reconnect path already fetches the existing account by ID, so `provider` is already correct. No change needed there.

**Backward compatibility:** `statePayload.provider` is optional; existing Gmail initiations (which don't set it) default to `'google'`. `redirect_path` is optional; defaults to `'/accounts'`.

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

**Backfill path:**

```
GET /drive/v3/files
  ?q=trashed=false
  &fields=files(id,name,mimeType,webViewLink,size,modifiedTime),nextPageToken
  &pageSize=100
  &pageToken=<backfill_page_token if set>

For each file: classify MIME type → extract or mark
Upsert to documents (ON CONFLICT (connected_account_id, drive_file_id) DO UPDATE)
Persist backfill_page_token after each page
On final page (no nextPageToken):
  - Get startPageToken from GET /drive/v3/changes/startPageToken
  - Update: backfill_complete=true, sync_cursor=startPageToken, backfill_page_token=null
```

**Incremental path:**

```
GET /drive/v3/changes
  ?pageToken=<sync_cursor>
  &fields=changes(file(id,name,mimeType,webViewLink,size,modifiedTime),removed),newStartPageToken
  &pageSize=100

For each change:
  - If removed=true → delete from documents WHERE drive_file_id = change.fileId AND connected_account_id = account.id
  - Else → classify and upsert
Update sync_cursor = newStartPageToken
```

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

**Upsert to `documents`:**

```typescript
await supabaseAdmin.from('documents').upsert({
  connected_account_id: account.id,
  user_id: account.user_id,
  drive_file_id: file.id,
  name: file.name,
  mime_type: file.mimeType,
  web_view_link: file.webViewLink ?? null,
  size_bytes: file.size ? parseInt(file.size) : null,
  drive_modified_time: file.modifiedTime ?? null,
  text_content: textContent ?? null,
  content_status: contentStatus,
  fetched_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}, { onConflict: 'connected_account_id,drive_file_id' })
```

**Error handling:** Per-file try/catch (skip and count errors, same as gmail-collector). Return `{ processed, errors, accounts: accounts?.length }`.

**Token safety:** Access token never stored. Refresh token read from Vault, never logged. File content never sent externally.

---

## Service layer: `src/services/documents.service.ts`

```typescript
// List documents for the current user
// Optionally filter by connected_account_id
export async function listDocuments(params?: {
  accountId?: string
  limit?: number
  offset?: number
}): Promise<Document[]>

// Get a single document by ID
export async function getDocument(id: string): Promise<Document | null>

// Initiate Drive OAuth
export async function initiateGoogleDriveOAuth(params?: {
  reconnect?: boolean
  accountId?: string
}): Promise<{ url: string }>
```

`listDocuments` selects from `documents` ordered by `created_at DESC`. Follows the same service pattern as `messages.service.ts`.

`initiateGoogleDriveOAuth` calls `google-drive-oauth-initiate` edge function with the user's JWT bearer token, same as `initiateOAuth` in `accounts.service.ts`.

---

## Hooks: `src/hooks/useDocuments.ts`

```typescript
// Paginated list query
export function useDocuments(params?: { accountId?: string }): UseQueryResult<Document[]>

// Single document detail query
export function useDocument(id: string | null): UseQueryResult<Document | null>
```

Query keys: `['documents']` / `['documents', accountId]` / `['document', id]`  
Same staleTime/refetchInterval pattern as `useMessages`.

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
  - If `content_status = 'extracted'`: render `text_content` in a scrollable `<pre>` or formatted pane
  - If `content_status = 'needs_processing'`: message "Content extraction pending (Epic 05)"
  - If `content_status = 'needs_ocr'`: message "OCR required — this file contains scanned content"
  - If `content_status = 'skipped'`: message "Content not available for this file type"
  - Show file metadata: name, MIME type, size, modified date, link to Drive (`web_view_link`)

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
- All other behavior (status badges, lifecycle buttons) unchanged

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

- `listDocuments` calls correct Supabase query, returns typed rows
- `getDocument` handles not-found (returns null)
- `initiateGoogleDriveOAuth` calls correct edge function, returns `{ url }`
- Error propagation

### `src/components/documents/DocumentsPage.test.tsx`

- Renders empty state when no documents
- Renders document list when data present
- Selecting a document renders detail pane
- Shows "Content extraction pending" for `needs_processing` status

### `src/components/accounts/AccountCard.test.tsx` — update

- Renders "Google Drive" label for `provider === 'google_drive'`
- All existing Gmail tests still pass

---

## Deployment order

1. **Migration 1** — `documents_table` → confirm Remote → `npm run gen:types`, commit types
2. **Migration 2** — `lifecycle_rpcs_v5` → confirm Remote
3. **Migration 3** — `drive_cron` → confirm Remote
4. **Deploy** `google-oauth-callback` (modified)
5. **Deploy** `google-drive-oauth-initiate` (new)
6. **Deploy** `google-drive-collector` (new)
7. **Frontend** build + deploy

**Ordering rationale:** Collector function is deployed before it runs (cron fires every 5 min, window is safe). Callback modification is backward-compatible (defaults to `'google'` for existing Gmail initiations). Lifecycle migration runs before the Drive accounts exist (safe noop if no Drive accounts yet).

---

## GitHub issues

| # | Work unit | Notes |
|---|---|---|
| EU-04-1 | Migration: documents table | RLS, indexes, idempotent |
| EU-04-2 | Migration: lifecycle_rpcs_v5 | Extend disconnect purge to documents |
| EU-04-3 | Migration: drive_cron | pg_cron job for google-drive-collector |
| EU-04-4 | types/provider.ts: add google_drive | Small frontend change |
| EU-04-5 | google-drive-oauth-initiate edge function | New, mirrors google-oauth-initiate |
| EU-04-6 | google-oauth-callback: use provider from state + redirect_path | Backward-compatible mod |
| EU-04-7 | google-drive-collector edge function | New, backfill + incremental |
| EU-04-8 | documents.service.ts | Service layer |
| EU-04-9 | useDocuments, useDocument hooks | React Query hooks |
| EU-04-10 | DocumentsPage + DocumentList + DocumentDetail | Two-pane viewer |
| EU-04-11 | AccountsPage + AccountCard: Drive support | Connect Drive button + Drive label |
| EU-04-12 | Router: /documents route + nav link | |
| EU-04-13 | Tests | Service, hook, component tests |
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
