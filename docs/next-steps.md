# Next Steps — Gmail Knowledge Collector

> Read this at the start of the session before touching any code. Everything below is prescriptive —
> exact file paths, exact code, exact deploy commands. Act on it top-to-bottom.

---

## Supabase project

Project ID: `ybgtzyutbvwfhgtlmnah`
Production URL: `https://knowledgecollector.netlify.app`
Edge function base URL: `https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/`

---

## Week 2: Google Drive Connector

**Goal:** Connect Google Drive accounts, collect file metadata + plain-text content, display in a
two-pane `/documents` viewer identical in structure to the `/emails` viewer.

**Architecture decision:** Reuse the existing `google-oauth-callback` edge function for Drive OAuth
by encoding `provider` in the HMAC-signed state JWT. No new redirect URI needed in GCP.

**Sync columns reuse:** `connected_accounts` already has `sync_cursor`, `backfill_complete`,
`backfill_page_token`, `backfill_start_history_id`. These work for Drive with Drive semantics
(`sync_cursor` = Changes API page token, `backfill_start_history_id` = startPageToken captured
before page 1). No new migration columns needed on `connected_accounts`.

---

### Step 0 — Manual GCP setup (do before any code)

1. In Google Cloud Console → APIs & Services → Enabled APIs → enable **Google Drive API**.
2. The OAuth consent screen already has `gmail.readonly`. Add scope
   `https://www.googleapis.com/auth/drive.readonly` and re-submit (still in Testing mode, no
   review needed).
3. No new redirect URI needed — Drive OAuth reuses
   `https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback`.

---

### Step 1 — Add `google_drive` to Provider type

**File:** `src/types/provider.ts`

Change:
```ts
export type Provider = 'google' | 'microsoft' | 'slack'
```
To:
```ts
export type Provider = 'google' | 'google_drive' | 'microsoft' | 'slack'
```

---

### Step 2 — Migration: `documents` table

**File:** `supabase/migrations/20260619000001_documents.sql`

```sql
-- documents: collected Google Drive files, written only by google-drive-collector.
-- Follows the same RLS pattern as messages: browser SELECT only, service-role writes.
CREATE TABLE IF NOT EXISTS documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connected_account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  drive_file_id        text NOT NULL,
  name                 text,
  mime_type            text,
  web_view_link        text,
  modified_time        timestamptz,
  size                 bigint,
  body_text            text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_account_file_key UNIQUE (connected_account_id, drive_file_id)
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'documents' AND policyname = 'users select own documents'
  ) THEN
    CREATE POLICY "users select own documents"
      ON documents FOR SELECT TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

-- Composite FK enforces at DB level that user_id matches the account owner (same pattern as
-- messages_user_id_connected_account_fk in migration 000002).
ALTER TABLE documents
  ADD CONSTRAINT IF NOT EXISTS documents_user_id_connected_account_fk
  FOREIGN KEY (user_id, connected_account_id)
  REFERENCES connected_accounts(user_id, id);

CREATE INDEX IF NOT EXISTS documents_user_id_idx
  ON documents (user_id);
CREATE INDEX IF NOT EXISTS documents_connected_account_id_idx
  ON documents (connected_account_id);
CREATE INDEX IF NOT EXISTS documents_user_id_modified_time_idx
  ON documents (user_id, modified_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS documents_user_id_account_modified_idx
  ON documents (user_id, connected_account_id, modified_time DESC NULLS LAST);
```

Apply via MCP (no credentials needed):
```
mcp__claude_ai_Supabase__apply_migration  project_id=ybgtzyutbvwfhgtlmnah  name=20260619000001_documents
```

After applying, regenerate types:
```bash
npm run gen:types
```
Commit both the migration file and the updated `src/types/database.types.ts`.

---

### Step 3 — Add cron job for Drive collector

**File:** `supabase/migrations/20260619000002_cron_drive_collector.sql`

```sql
-- Schedule google-drive-collector every 5 minutes (same cadence as Gmail).
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
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'CRON_SECRET'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Apply via MCP after Step 2.

---

### Step 4 — Update `google-oauth-callback` to be provider-aware

**File:** `supabase/functions/google-oauth-callback/index.ts`

Two changes only — everything else stays the same:

**Change 1:** Add `provider` (optional, backward-compat) to `StatePayload`:
```ts
interface StatePayload {
  user_id: string
  nonce: string
  exp: number
  provider?: string   // ← ADD THIS LINE
}
```

**Change 2:** In the `connected_accounts` upsert, replace the hardcoded `'google'` with the
value from the state, and read `granted_scopes` from the token response instead of hardcoding:

In the `Deno.serve` handler, update the token parsing to capture scope:
```ts
const tokens = await tokenRes.json() as {
  refresh_token?: string
  access_token: string
  scope?: string        // ← ADD THIS
}
```

In the upsert object, replace:
```ts
provider: 'google',
granted_scopes: 'openid email https://www.googleapis.com/auth/gmail.readonly',
```
With:
```ts
provider: statePayload.provider ?? 'google',
granted_scopes: tokens.scope ?? '',
```

Deploy after making both changes:
```bash
# via MCP — pass the full updated file content to deploy_edge_function
mcp__claude_ai_Supabase__deploy_edge_function  project_id=ybgtzyutbvwfhgtlmnah  name=google-oauth-callback  verify_jwt=false
```

---

### Step 5 — New edge function: `google-drive-initiate`

**File:** `supabase/functions/google-drive-initiate/index.ts`

Copy of `google-oauth-initiate` with three differences:
1. Scope is `https://www.googleapis.com/auth/drive.readonly` (no `openid`, no `email`)
2. State JWT payload includes `provider: 'google_drive'`
3. REDIRECT_URI is the same shared callback

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly'
const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function buildStateJwt(userId: string, stateSecret: string, nonce: string): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    user_id: userId,
    nonce,
    provider: 'google_drive',   // tells the callback which provider this is
    exp: Math.floor(Date.now() / 1000) + 300,
  })))
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stateSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(sig)}`
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const stateSecret = Deno.env.get('STATE_SECRET')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
  }

  const nonce = crypto.randomUUID()
  const state = await buildStateJwt(user.id, stateSecret, nonce)

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const { error: nonceErr } = await supabaseAdmin
    .from('oauth_nonces')
    .insert({ nonce, user_id: user.id, expires_at: expiresAt })
  if (nonceErr) {
    console.error('Failed to store OAuth nonce:', nonceErr.message)
    return Response.json({ error: 'Internal error' }, { status: 500, headers: corsHeaders })
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`
  return Response.json({ url }, { headers: corsHeaders })
})
```

Deploy:
```bash
mcp__claude_ai_Supabase__deploy_edge_function  project_id=ybgtzyutbvwfhgtlmnah  name=google-drive-initiate  verify_jwt=false
```

---

### Step 6 — New edge function: `google-drive-collector`

**File:** `supabase/functions/google-drive-collector/index.ts`

Key behavioral notes before reading the code:
- Fetches all non-trashed files via `files.list`, paginated (backfill path)
- Before page 1, captures `startPageToken` from `changes/startPageToken` endpoint — stored in
  `backfill_start_history_id` column (same pattern as Gmail historyId)
- After backfill, uses Changes API for incremental sync (`sync_cursor` = Changes page token)
- On 410 Gone from Changes API: resets to backfill (same as Gmail 404 reset)
- Exports Google Workspace files (Docs, Sheets, Slides) as plain text
- Downloads raw content for `text/*` files ≤ 5MB; stores metadata-only for everything else
- Drive `size` is a string in the API response — cast with `parseInt`

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const MAX_CONTENT_BYTES = 5 * 1024 * 1024   // skip content extraction above 5MB

// Google Workspace MIME types → export format
const EXPORTABLE = new Map<string, string>([
  ['application/vnd.google-apps.document',     'text/plain'],
  ['application/vnd.google-apps.spreadsheet',  'text/csv'],
  ['application/vnd.google-apps.presentation', 'text/plain'],
])

// Native text types we can download directly
const DOWNLOADABLE_PREFIXES = ['text/']

interface DriveFile {
  id: string
  name?: string
  mimeType?: string
  modifiedTime?: string
  size?: string      // string in Drive API, not number
  webViewLink?: string
}

interface ConnectedAccountRow {
  id: string
  user_id: string
  email_address: string
  sync_cursor: string | null
  backfill_complete: boolean
  backfill_page_token: string | null
  backfill_start_history_id: string | null
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error('token_refresh_failed'), {
      tokenError: (err as Record<string, string>).error,
    })
  }
  const data = await res.json() as { access_token: string }
  return data.access_token
}

async function fetchTextContent(accessToken: string, file: DriveFile): Promise<string | null> {
  const exportMime = EXPORTABLE.get(file.mimeType ?? '')
  const sizeBytes = parseInt(file.size ?? '0', 10)

  try {
    if (exportMime) {
      // Google Workspace file — export as text
      const res = await fetch(
        `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!res.ok) return null
      return await res.text()
    }

    if (
      DOWNLOADABLE_PREFIXES.some(p => (file.mimeType ?? '').startsWith(p)) &&
      sizeBytes > 0 && sizeBytes <= MAX_CONTENT_BYTES
    ) {
      // Native text file — download directly
      const res = await fetch(
        `${DRIVE_API}/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!res.ok) return null
      return await res.text()
    }
  } catch {
    // Never let content fetch abort the upsert — metadata is still valuable
  }

  return null
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')!
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('connected_accounts')
    .select('id, user_id, email_address, sync_cursor, backfill_complete, backfill_page_token, backfill_start_history_id')
    .eq('status', 'active')
    .eq('provider', 'google_drive')     // only Drive accounts

  if (accountsError) {
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const account of (accounts ?? []) as ConnectedAccountRow[]) {
    try {
      const { data: refreshToken } = await supabaseAdmin
        .rpc('get_vault_secret', { secret_name: account.id })

      if (!refreshToken) {
        console.error(`No vault secret for account ${account.id}`)
        errors++
        continue
      }

      let accessToken: string
      try {
        accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
      } catch (err: unknown) {
        const tokenErr = err as { tokenError?: string }
        if (tokenErr.tokenError === 'invalid_grant' || tokenErr.tokenError === 'token_revoked') {
          await supabaseAdmin
            .from('connected_accounts')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('id', account.id)
        }
        errors++
        continue
      }

      if (!account.backfill_complete) {
        // === BACKFILL PATH ===

        // Capture the Changes startPageToken before fetching page 1.
        // Any files modified during the multi-run backfill will be replayed
        // by the Changes API after backfill completes.
        let startPageToken = account.backfill_start_history_id
        if (!startPageToken) {
          const tokenRes = await fetch(`${DRIVE_API}/changes/startPageToken`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (!tokenRes.ok) { errors++; continue }
          const tokenData = await tokenRes.json() as { startPageToken?: string }
          startPageToken = tokenData.startPageToken ?? null
        }

        // List files: not trashed, 200 per page, metadata we store
        const params = new URLSearchParams({
          pageSize: '200',
          fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken',
          q: 'trashed=false',
        })
        if (account.backfill_page_token) {
          params.set('pageToken', account.backfill_page_token)
        }

        const listRes = await fetch(`${DRIVE_API}/files?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!listRes.ok) { errors++; continue }
        const listData = await listRes.json() as {
          files?: DriveFile[]
          nextPageToken?: string
        }

        for (const file of (listData.files ?? [])) {
          try {
            const bodyText = await fetchTextContent(accessToken, file)
            await supabaseAdmin.from('documents').upsert({
              connected_account_id: account.id,
              user_id: account.user_id,
              drive_file_id: file.id,
              name: file.name ?? null,
              mime_type: file.mimeType ?? null,
              web_view_link: file.webViewLink ?? null,
              modified_time: file.modifiedTime ?? null,
              size: file.size ? parseInt(file.size, 10) : null,
              body_text: bodyText,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'connected_account_id,drive_file_id', ignoreDuplicates: false })
            processed++
          } catch {
            // Skip individual file failures
          }
        }

        if (!listData.nextPageToken) {
          // Final page — backfill done
          await supabaseAdmin
            .from('connected_accounts')
            .update({
              backfill_complete: true,
              backfill_page_token: null,
              backfill_start_history_id: startPageToken,
              sync_cursor: startPageToken,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', account.id)
        } else {
          // More pages — persist progress atomically
          await supabaseAdmin
            .from('connected_accounts')
            .update({
              backfill_start_history_id: startPageToken,
              backfill_page_token: listData.nextPageToken,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', account.id)
        }

      } else {
        // === INCREMENTAL CHANGES API PATH ===
        const changesParams = new URLSearchParams({
          pageToken: account.sync_cursor!,
          fields: 'changes(file(id,name,mimeType,modifiedTime,size,webViewLink),removed,fileId),nextPageToken,newStartPageToken',
          includeRemoved: 'true',
        })

        const changesRes = await fetch(`${DRIVE_API}/changes?${changesParams}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })

        if (!changesRes.ok) {
          if (changesRes.status === 410) {
            // Page token expired — reset to backfill
            await supabaseAdmin
              .from('connected_accounts')
              .update({
                sync_cursor: null,
                backfill_complete: false,
                backfill_start_history_id: null,
                backfill_page_token: null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', account.id)
          }
          errors++
          continue
        }

        const changesData = await changesRes.json() as {
          changes?: Array<{
            fileId: string
            removed?: boolean
            file?: DriveFile
          }>
          nextPageToken?: string
          newStartPageToken?: string
        }

        const newCursor = changesData.newStartPageToken ?? changesData.nextPageToken ?? account.sync_cursor

        for (const change of (changesData.changes ?? [])) {
          try {
            if (change.removed || !change.file) {
              // File deleted or moved to trash — mark by removing body_text (keep metadata for audit)
              await supabaseAdmin
                .from('documents')
                .update({ body_text: null, updated_at: new Date().toISOString() })
                .eq('connected_account_id', account.id)
                .eq('drive_file_id', change.fileId)
              continue
            }

            const file = change.file
            const bodyText = await fetchTextContent(accessToken, file)
            await supabaseAdmin.from('documents').upsert({
              connected_account_id: account.id,
              user_id: account.user_id,
              drive_file_id: file.id,
              name: file.name ?? null,
              mime_type: file.mimeType ?? null,
              web_view_link: file.webViewLink ?? null,
              modified_time: file.modifiedTime ?? null,
              size: file.size ? parseInt(file.size, 10) : null,
              body_text: bodyText,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'connected_account_id,drive_file_id', ignoreDuplicates: false })
            processed++
          } catch {
            // Skip individual change failures
          }
        }

        await supabaseAdmin
          .from('connected_accounts')
          .update({
            sync_cursor: newCursor,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', account.id)
      }

    } catch {
      errors++
    }
  }

  return Response.json({ processed, errors, accounts: accounts?.length ?? 0 })
})
```

Deploy:
```bash
mcp__claude_ai_Supabase__deploy_edge_function  project_id=ybgtzyutbvwfhgtlmnah  name=google-drive-collector  verify_jwt=false
```

---

### Step 7 — Frontend: service, hooks, components

#### `src/services/documents.service.ts` — create new file

```ts
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type Document = Tables<'documents'>
export type DocumentListItem = Pick<
  Document,
  'id' | 'name' | 'mime_type' | 'web_view_link' | 'modified_time' | 'connected_account_id' | 'size'
>

export async function getDocuments(connectedAccountId?: string, offset = 0): Promise<DocumentListItem[]> {
  const base = supabase
    .from('documents')
    .select('id, name, mime_type, web_view_link, modified_time, connected_account_id, size')

  const filtered = connectedAccountId
    ? base.eq('connected_account_id', connectedAccountId)
    : base

  const { data, error } = await filtered
    .order('modified_time', { ascending: false })
    .range(offset, offset + 199)

  if (error) throw error
  return data
}

export async function getDocumentBody(id: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('body_text')
    .eq('id', id)
    .single()
  if (error) {
    if ((error as { code?: string }).code === 'PGRST116') return null
    throw error
  }
  return data?.body_text ?? null
}
```

#### `src/hooks/useDocuments.ts` — create new file

Mirrors `useMessages` exactly:

```ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { getDocuments } from '@/services/documents.service'

export function useDocuments(connectedAccountId?: string) {
  return useInfiniteQuery({
    queryKey: ['documents', connectedAccountId ?? 'all'],
    queryFn: ({ pageParam }) => getDocuments(connectedAccountId, pageParam as number),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 200 ? allPages.length * 200 : undefined,
    initialPageParam: 0,
    refetchInterval: 60_000,
  })
}
```

#### `src/hooks/useDocumentBody.ts` — create new file

Mirrors `useMessage`:

```ts
import { useQuery } from '@tanstack/react-query'
import { getDocumentBody } from '@/services/documents.service'

export function useDocumentBody(id: string | null) {
  return useQuery({
    queryKey: ['document-body', id],
    queryFn: () => getDocumentBody(id!),
    enabled: !!id,
  })
}
```

#### `src/components/documents/DocumentItem.tsx` — create new file

Mirrors `MessageItem`. Shows file name, modified date, a human-readable mime label, and
the account email address badge (from `accountMap`).

```ts
import type { DocumentListItem } from '@/services/documents.service'
import styles from './DocumentItem.module.scss'

interface Props {
  document: DocumentListItem
  isSelected: boolean
  onClick: () => void
  accountEmail: string | undefined
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000)
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function mimeLabel(mimeType: string | null): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.document':     'Doc',
    'application/vnd.google-apps.spreadsheet':  'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/pdf':                          'PDF',
    'text/plain':                               'Text',
    'text/csv':                                 'CSV',
  }
  return map[mimeType ?? ''] ?? 'File'
}

export default function DocumentItem({ document, isSelected, onClick, accountEmail }: Props) {
  return (
    <button
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles.name}>{document.name ?? '(unnamed)'}</div>
      <div className={styles.date}>{formatDate(document.modified_time)}</div>
      <div className={styles.meta}>
        <span className={styles.mimeLabel}>{mimeLabel(document.mime_type)}</span>
        {accountEmail && <span className={styles.accountBadge}>{accountEmail}</span>}
      </div>
    </button>
  )
}
```

Create `src/components/documents/DocumentItem.module.scss` — copy
`src/components/email/MessageItem.module.scss` and swap `.subject` → `.name`,
`.snippet` → `.meta`. Add `.mimeLabel` and `.accountBadge` to match the badge style in
`MessageItem.module.scss` (look at `.accountBadge` in that file for the pattern).

#### `src/components/documents/DocumentDetail.tsx` — create new file

No iframe needed — content is plain text. Adds an "Open in Drive →" external link.

```ts
import styles from './DocumentDetail.module.scss'

interface Props {
  name: string | null | undefined
  mimeType: string | null | undefined
  modifiedTime: string | null | undefined
  webViewLink: string | null | undefined
  bodyText: string | null | undefined
  isLoading: boolean
}

function formatFullDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString([], {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function DocumentDetail({ name, mimeType, modifiedTime, webViewLink, bodyText, isLoading }: Props) {
  if (isLoading) return <div className={styles.empty}>Loading…</div>
  if (!name) return <div className={styles.empty}>Select a document to view it.</div>

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <h2 className={styles.name}>{name}</h2>
        <div className={styles.meta}>
          <span>{mimeType}</span>
          <span>Modified: {formatFullDate(modifiedTime)}</span>
          {webViewLink && (
            <a
              href={webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.driveLink}
            >
              Open in Drive →
            </a>
          )}
        </div>
      </div>
      <div className={styles.body}>
        {bodyText ? (
          <pre className={styles.text}>{bodyText}</pre>
        ) : (
          <p className={styles.noContent}>No text content available. Open in Drive to view.</p>
        )}
      </div>
    </div>
  )
}
```

Create `src/components/documents/DocumentDetail.module.scss` — copy
`src/components/email/MessageDetail.module.scss`. Replace `.iframe` with `.text`
(pre-formatted block, `white-space: pre-wrap`, `overflow-x: auto`).
Add `.driveLink` as a styled anchor (same color as connect button).

#### `src/components/documents/DocumentList.tsx` — create new file

```ts
import type { DocumentListItem } from '@/services/documents.service'
import DocumentItem from './DocumentItem'
import styles from './DocumentList.module.scss'

interface Props {
  documents: DocumentListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  accountMap: Map<string, string>
}

export default function DocumentList({ documents, selectedId, onSelect, accountMap }: Props) {
  return (
    <div className={styles.list}>
      {documents.map(doc => (
        <DocumentItem
          key={doc.id}
          document={doc}
          isSelected={doc.id === selectedId}
          onClick={() => onSelect(doc.id)}
          accountEmail={accountMap.get(doc.connected_account_id ?? '')}
        />
      ))}
    </div>
  )
}
```

Create `src/components/documents/DocumentList.module.scss` — copy
`src/components/email/MessageList.module.scss`.

#### `src/components/documents/DocumentsPage.tsx` — create new file

Mirror of `EmailPage.tsx`. Two-pane: list left, detail right. Filter dropdown (shown when
2+ Drive accounts). Load more. Detail pane shows `DocumentDetail`.

```ts
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { useDocuments } from '@/hooks/useDocuments'
import { useDocumentBody } from '@/hooks/useDocumentBody'
import DocumentList from './DocumentList'
import DocumentDetail from './DocumentDetail'
import EmptyState from '@/components/shared/EmptyState'
import styles from './DocumentsPage.module.scss'

export default function DocumentsPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<{ name?: string | null; mimeType?: string | null; modifiedTime?: string | null; webViewLink?: string | null } | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [accountFilter, setAccountFilter] = useState<string | undefined>()

  const { data: allAccounts } = useAccounts()
  // Only Drive accounts in the filter dropdown
  const driveAccounts = useMemo(
    () => allAccounts?.filter(a => a.provider === 'google_drive') ?? [],
    [allAccounts],
  )

  const {
    data: docsData,
    isLoading: docsLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDocuments(accountFilter)
  const { data: bodyText, isLoading: bodyLoading } = useDocumentBody(selectedId)

  const documents = docsData?.pages.flat() ?? []

  const accountMap = useMemo(
    () => new Map(driveAccounts.map(a => [a.id, a.email_address])),
    [driveAccounts],
  )

  const handleSelect = (id: string) => {
    const doc = documents.find(d => d.id === id)
    setSelectedId(id)
    setSelectedDoc(doc ? { name: doc.name, mimeType: doc.mime_type, modifiedTime: doc.modified_time, webViewLink: doc.web_view_link } : null)
    setShowDetail(true)
  }

  const handleFilterChange = (id: string | undefined) => {
    setAccountFilter(id)
    setSelectedId(null)
    setShowDetail(false)
  }

  const noDriveAccounts = driveAccounts.length === 0
  const hasDocuments = documents.length > 0
  const noDocuments = !docsLoading && !noDriveAccounts && documents.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Documents</h1>
        {driveAccounts.length > 1 && (
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="drive-account-filter">Account</label>
            <select
              id="drive-account-filter"
              className={styles.filter}
              value={accountFilter ?? ''}
              onChange={e => handleFilterChange(e.target.value || undefined)}
            >
              <option value="">All accounts</option>
              {driveAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.email_address}</option>
              ))}
            </select>
          </div>
        )}
      </header>

      <div className={styles.layout}>
        <div className={`${styles.listPane} ${showDetail ? styles.hidden : ''}`}>
          {noDriveAccounts && (
            <EmptyState
              message="Connect a Google Drive account to get started."
              action={{ label: 'Go to Accounts', onClick: () => navigate('/accounts') }}
            />
          )}
          {noDocuments && (
            <EmptyState message="Your documents are being collected. Check back in a few minutes." />
          )}
          {!noDriveAccounts && docsLoading && <p className={styles.loading}>Loading…</p>}
          {hasDocuments && (
            <DocumentList
              documents={documents}
              selectedId={selectedId}
              onSelect={handleSelect}
              accountMap={accountMap}
            />
          )}
          {hasDocuments && hasNextPage && (
            <button
              className={styles.loadMore}
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>

        <div className={`${styles.detailPane} ${showDetail ? styles.visible : ''}`}>
          {showDetail && (
            <button className={styles.backToList} onClick={() => setShowDetail(false)}>
              ← Back
            </button>
          )}
          <DocumentDetail
            name={selectedDoc?.name}
            mimeType={selectedDoc?.mimeType}
            modifiedTime={selectedDoc?.modifiedTime}
            webViewLink={selectedDoc?.webViewLink}
            bodyText={bodyText}
            isLoading={!!selectedId && bodyLoading}
          />
        </div>
      </div>
    </div>
  )
}
```

Create `src/components/documents/DocumentsPage.module.scss` — copy
`src/components/email/EmailPage.module.scss` exactly.

---

### Step 8 — Wire up routing and navigation

**File:** `src/App.tsx`

Add the lazy import and route:

```ts
// Add with the other lazy imports at the top:
const DocumentsPage = lazy(() => import('@/components/documents/DocumentsPage'))

// Add inside <Routes> after the /emails route:
<Route path="/documents" element={
  <ProtectedRoute><DocumentsPage /></ProtectedRoute>
} />
```

**File:** `src/components/accounts/AccountsPage.tsx`

1. Update `handleConnect` to accept a `Provider` argument:
```ts
const handleConnect = async (provider: Provider) => {
  setConnectError(null)
  try {
    await initiateOAuth(provider)
  } catch (err) {
    setConnectError(err instanceof Error ? err.message : String(err))
  }
}
```

2. Add the Drive button in `headerActions`:
```tsx
<button className={styles.connectBtn} onClick={() => handleConnect('google')}>
  Connect Gmail
</button>
<button className={styles.connectBtn} onClick={() => handleConnect('google_drive')}>
  Connect Drive
</button>
```

3. Add "View Documents →" button below "View Emails →" (or conditionally show it when
Drive accounts exist):
```tsx
{accounts && accounts.some(a => a.provider === 'google_drive') && (
  <div className={styles.viewEmails}>
    <button className={styles.connectBtn} onClick={() => navigate('/documents')}>
      View Documents →
    </button>
  </div>
)}
```

4. Add the `Provider` import at the top:
```ts
import type { Provider } from '@/types/provider'
```

**File:** `src/services/accounts.service.ts`

Update `initiateOAuth` to route to the correct function by provider:
```ts
export async function initiateOAuth(provider: Provider): Promise<void> {
  const fnMap: Partial<Record<Provider, string>> = {
    google:       'google-oauth-initiate',
    google_drive: 'google-drive-initiate',
  }
  const fnName = fnMap[provider]
  if (!fnName) throw new Error(`Provider '${provider}' not implemented`)
  const { data, error } = await supabase.functions.invoke<{ url: string }>(fnName)
  if (error) throw error
  if (data?.url) window.location.href = data.url
}
```

**File:** `src/components/accounts/AccountCard.tsx`

Fix the reconnect button to use the account's own provider (currently hardcoded to `'google'`):
```tsx
{account.status === 'error' && (
  <button
    className={styles.reconnect}
    onClick={() => initiateOAuth(account.provider as Provider)}
  >
    Reconnect
  </button>
)}
```

Also update the provider label display:
```tsx
// Replace:
<span className={styles.provider}>Google</span>
// With:
<span className={styles.provider}>
  {account.provider === 'google' ? 'Gmail' : account.provider === 'google_drive' ? 'Drive' : account.provider}
</span>
```

Add `import type { Provider } from '@/types/provider'` to the AccountCard imports.

---

### Step 9 — Tests

Add tests in `src/services/documents.service.test.ts` and
`src/components/documents/DocumentsPage.test.tsx` following the exact patterns in
`src/services/messages.service.test.ts` and `src/components/email/EmailPage.test.tsx`.

Tests to write:
- `getDocuments()` returns list items with correct fields
- `getDocuments(accountId)` applies the account filter
- `getDocumentBody(id)` returns body_text
- `DocumentsPage` renders EmptyState when no Drive accounts
- `DocumentsPage` renders document list when documents exist
- `DocumentsPage` shows filter only when 2+ Drive accounts

---

### Step 10 — Deploy checklist

```bash
# 1. Apply migrations (via MCP, no credentials needed)
# mcp__claude_ai_Supabase__apply_migration  — documents table
# mcp__claude_ai_Supabase__apply_migration  — cron job

# 2. Regenerate types
npm run gen:types

# 3. TypeScript + lint + tests — all must pass
npm run typecheck
npm run lint
npm test

# 4. Deploy edge functions (via MCP)
# mcp__claude_ai_Supabase__deploy_edge_function  google-oauth-callback  (provider-aware update)
# mcp__claude_ai_Supabase__deploy_edge_function  google-drive-initiate  (new)
# mcp__claude_ai_Supabase__deploy_edge_function  google-drive-collector (new)

# 5. Verify migration list
npx supabase migration list --linked
# Should show 8 migrations in Remote column

# 6. Commit + PR to test
# PR title: "feat: Google Drive connector (Week 2)"
```

---

## Week 3: Slack Connector (outline)

Same overall pattern. Key differences from Drive:

- OAuth: Slack uses `https://slack.com/oauth/v2/authorize` with its own PKCE flow (not Google)
- Scopes needed: `channels:history`, `channels:read`, `users:read`
- Data model: new `slack_messages` table (channel, timestamp, user, text) — or extend `documents` with a `source_type` column
- Incremental sync: Slack Conversations API `conversations.history` with `cursor` pagination
- No backfill token concept — just paginate backward from `latest` with `oldest` = 1 year ago
- Provider string: `'slack'` (already in the Provider union type)
- Edge functions: `slack-oauth-initiate`, `slack-oauth-callback` (Slack uses different token exchange), `slack-collector`
- Slack does NOT use Google OAuth — it needs its own callback function and redirect URI

---

## Week 4: Vector store + semantic search (outline)

- Enable `pgvector` extension in Supabase (`CREATE EXTENSION IF NOT EXISTS vector`)
- Add `embedding vector(1536)` column to both `messages` and `documents` (and slack_messages)
- New edge function `embed-content`: triggered by cron or pg trigger, calls OpenAI `text-embedding-3-small` on `body_text`, writes the vector back
- New Supabase function `match_documents(query_embedding vector, match_count int)` using `<=>` cosine distance operator
- New `/search` page: text input → call `text-embedding-3-small` on the query → call `match_documents` → show results ranked by similarity
- **PII warning (already in CLAUDE.md):** Email body content is untrusted. Before sending to OpenAI, add prompt injection shielding. For embeddings this is low-risk (embeddings don't execute), but document it.
- Cost: `text-embedding-3-small` is $0.02/1M tokens — cheap. A 12-month inbox of 2,400 emails averages ~500 tokens each = $0.024 total to embed one account.

---

## Gotchas / known sharp edges

- **Drive `size` is a string:** `parseInt(file.size ?? '0', 10)` before storing as bigint.
- **Google Workspace files have no `size` field** in `files.list` — they're virtual. The export API has no size limit documented, but requests for very large docs (1MB+ of text) can time out. The `MAX_CONTENT_BYTES` guard applies to native files only; for Workspace exports, consider catching a timeout and storing `null` for body_text.
- **Changes API `newStartPageToken`:** Only present on the last page of changes (when there are no more changes). While there are more change pages, the response has `nextPageToken` but NOT `newStartPageToken`. This is different from Gmail where `historyId` is always present. The collector above uses `changesData.newStartPageToken ?? changesData.nextPageToken` as the new cursor — this means that if there are multiple pages of changes in one cron run, only the final page's cursor is written. This is correct behavior; the next run will resume from where the last write left off.
- **Shared Drive files:** `files.list` without `driveId`/`supportsAllDrives` only returns files from the user's personal Drive. Shared Drives require extra parameters. Defer this — personal Drive is sufficient for the demo.
- **`connected_accounts` unique constraint:** `UNIQUE (user_id, email_address)`. Drive and Gmail share the same Google account email. This means if a user connects Gmail AND Drive from the same Google account, the upsert uses `user_id,email_address` as the conflict key and would overwrite the Gmail row with `provider='google_drive'`. Fix: change the unique constraint to `(user_id, email_address, provider)`. This requires a new migration to drop and recreate the constraint. Do this before implementing Drive OAuth.

  Migration snippet:
  ```sql
  ALTER TABLE connected_accounts
    DROP CONSTRAINT connected_accounts_user_email_unique;
  ALTER TABLE connected_accounts
    ADD CONSTRAINT connected_accounts_user_email_provider_unique
    UNIQUE (user_id, email_address, provider);
  ```
  And update the callback upsert `onConflict` from `'user_id,email_address'` to
  `'user_id,email_address,provider'`.

- **`oauth_nonces` cleanup:** Expired nonces accumulate. Add a cron job to delete them:
  ```sql
  SELECT cron.schedule(
    'cleanup-oauth-nonces',
    '0 * * * *',  -- every hour
    $$ DELETE FROM oauth_nonces WHERE expires_at < now(); $$
  );
  ```
  This can go in the same migration as the cron_drive_collector or in its own migration.
