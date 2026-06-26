# Epic 03 — OAuth Lifecycle Design

**Date:** 2026-06-25  
**Slug:** oauth-lifecycle  
**Branch:** plan/oauth-lifecycle  
**Status:** Revised after Codex plan review v1

---

## Revision history

| Rev | Date | Summary |
|-----|------|---------|
| 1 | 2026-06-25 | Initial spec from brainstorm |
| 2 | 2026-06-25 | Codex plan review v1 — fixed constraint name, revoke error handling, vault_delete_secret grants, reconnect JWT binding, GET→POST initiate, callback conflict target, test gaps, rollback note, safety criteria |

---

## Goal

Make a Gmail connection survive being broken and let the user control it. Four capabilities:

1. **Disconnect** — revoke at Google, stop syncing, keep or purge messages per user choice
2. **Delete** — revoke at Google, remove the connection row, always cascade messages
3. **Reconnect** — provider-aware, always forces `prompt=consent` for a fresh refresh token
4. **Provider-aware unique key** — `UNIQUE (user_id, email_address)` → `UNIQUE (user_id, provider, email_address)`, prerequisite for Drive OAuth in Epic 04

---

## Decisions (settled in brainstorm)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Disconnect shows a consent modal: keep data or purge data | Emails may be important for downstream file creation; company may want to retain them even when the connection is paused |
| D2 | Delete always purges (cascade), no choice offered | Delete is destructive by intent |
| D3 | Always attempt Google revoke on disconnect and delete; treat `2xx` and terminal `4xx` (400/401/403) as success; retain token and return error on `5xx` or network failure | Leaving a live Google authorization dangling is worse than a redundant revoke call; but losing the token before a successful revoke is also a failure mode |
| D4 | Reconnect always sends `prompt=consent` | Guarantees a fresh refresh token; silent reuse risks returning the same dead grant |

---

## Architecture invariants (from CLAUDE.md)

- Edge functions are the only path to Google revoke and Vault operations — the browser never calls either directly
- Service layer is the only browser path to Supabase
- RLS: SELECT-own only on `connected_accounts`, no authenticated write policies
- Vault delete helper does not yet exist — must be created in this epic
- Vault secret key is raw `account.id` (matching existing callback and collector code — do not rename)

---

## Safety rules compliance

All five mandatory rules from `docs/project-brief.md` apply to this epic:

1. **Token isolation** — refresh tokens read from Vault inside edge functions only; never returned to browser; `vault_delete_secret` called after successful revoke
2. **Read-only browser** — all writes (UPDATE status, DELETE messages, DELETE connected_accounts) happen in edge functions under service role; no new authenticated write policies
3. **PII containment** — collected emails are never sent to any third-party service; purge/delete remove them from Supabase only
4. **Secrets out of git** — no tokens, keys, or secrets committed; Vault is the secret store
5. **Untrusted content** — no email content is processed in this epic; note carried forward for Epic 07

---

## Data model changes

### Migration 1 — provider-aware unique key

**File:** `supabase/migrations/<timestamp>_provider_aware_unique_key.sql`

**Actual constraint name** (confirmed from `20260617000001_initial_schema.sql` line 15): `connected_accounts_user_email_unique`

```sql
-- Drop the actual existing constraint, guard both possible names for safety
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_email_unique'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      DROP CONSTRAINT connected_accounts_user_email_unique;
  END IF;

  -- Also guard the alternative name in case of prior partial migration
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_id_email_address_key'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      DROP CONSTRAINT connected_accounts_user_id_email_address_key;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_id_provider_email_address_key'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      ADD CONSTRAINT connected_accounts_user_id_provider_email_address_key
        UNIQUE (user_id, provider, email_address);
  END IF;
END $$;
```

**Note:** No data migration needed — all existing rows have `provider = 'google'`; the new constraint is equivalent for current data.

### No status enum change

`error` status continues to represent needs-reauth. No new `needs_reauth` value, no CHECK migration. The UI labels the state clearly; the status string is internal.

---

## Vault changes

### New helper: `vault_delete_secret`

The existing Vault helpers (`vault_create_secret`, `vault_update_secret`, `vault_get_secret`, `vault_get_secret_id`) have no delete. This epic adds one, following the exact grant pattern in `20260617000002_vault_helpers.sql`.

**Migration 2 — vault delete helper**

```sql
CREATE OR REPLACE FUNCTION vault_delete_secret(secret_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = secret_name;
END;
$$;

-- Match the grant pattern from 20260617000002_vault_helpers.sql
REVOKE ALL ON FUNCTION vault_delete_secret(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_delete_secret(text) TO service_role;
```

**Vault secret naming:** secrets are keyed by raw `account.id` (matching existing `google-oauth-callback` and `gmail-collector` code). Do not introduce a prefixed naming scheme in this epic.

---

## Edge functions

### New function: `google-account-disconnect`

**Invocation:** POST from browser via `accounts.service.ts`. Authenticated via Supabase JWT in Authorization header.

**Input body:**
```json
{
  "accountId": "<connected_account uuid>",
  "purgeMessages": true | false
}
```

**Steps:**
1. Verify JWT — extract `user_id`
2. Fetch the `connected_accounts` row for `(user_id, accountId)` — 404 if not found or not owned
3. Fetch refresh token from Vault by `account.id`
4. POST to `https://oauth2.googleapis.com/revoke` with `Content-Type: application/x-www-form-urlencoded` body `token=<refresh_token>` (not query string — avoids token in logs)
   - `2xx` → success, proceed
   - `400 / 401 / 403` → terminal failure at Google (token already dead), treat as success, proceed
   - `5xx` or network error → return `502` to browser; retain Vault token for retry; do NOT update status or purge
5. If `purgeMessages === true`: `DELETE FROM messages WHERE connected_account_id = accountId` (service role)
6. `UPDATE connected_accounts SET status = 'revoked', sync_cursor = NULL WHERE id = accountId` (service role)
7. Call `vault_delete_secret(account.id)` to remove the refresh token
8. Return `200 { success: true }`

**Error handling:**
- Vault fetch fails (token already gone): POST revoke with empty token — Google returns 400, treat as terminal success, proceed
- Step 5/6/7 DB errors: return `500`; status may be inconsistent — acceptable, user can retry

**Collector race:** The `gmail-collector` re-checks `status = 'active'` before writing messages (verified in existing code). A disconnect that sets `status = 'revoked'` before the collector's next write will prevent reinserts. No additional locking needed.

### New function: `google-account-delete`

**Invocation:** POST from browser via `accounts.service.ts`.

**Input body:**
```json
{
  "accountId": "<connected_account uuid>"
}
```

**Steps:**
1. Verify JWT — extract `user_id`
2. Fetch the `connected_accounts` row — 404 if not found or not owned
3. Fetch refresh token from Vault by `account.id`
4. POST to Google revoke (same as disconnect — body, not query string; same terminal/retry logic)
   - On `5xx` / network error: return `502`; do NOT delete
5. `DELETE FROM connected_accounts WHERE id = accountId` — cascades to `messages` via FK on delete cascade
6. Call `vault_delete_secret(account.id)`
7. Return `200 { success: true }`

### Modified function: `google-oauth-initiate`

**Reconnect path change:** Accept `reconnect=true` and `accountId=<uuid>` in the POST body (not GET query params — must carry Supabase JWT via Authorization header like existing calls).

**Steps for reconnect:**
1. Verify JWT — extract `user_id`
2. Fetch `connected_accounts` row for `(user_id, accountId)` — 404 if not owned
3. Embed `reconnect_account_id` and `provider` in the signed state JWT alongside `user_id` and nonce
4. Redirect to Google with `prompt=consent` (already present for new connections)

**Callback update (EU-26-8):** `google-oauth-callback` currently upserts with `onConflict: 'user_id,email_address'` (line 156). After Migration 1 removes that constraint, this will fail. Must update to `onConflict: 'user_id,provider,email_address'` and deploy alongside the migration.

**Reconnect validation in callback:** When `reconnect_account_id` is present in the state JWT, verify the Google-returned email matches the `email_address` on the `connected_accounts` row. If mismatch, return `400` — prevents authorizing account B when reconnecting account A.

---

## Service layer changes

**File:** `src/services/accounts.service.ts`

New methods:
- `disconnectAccount(accountId: string, purgeMessages: boolean): Promise<void>` — POST to `google-account-disconnect`
- `deleteAccount(accountId: string): Promise<void>` — POST to `google-account-delete`
- `reconnectAccount(accountId: string): Promise<{ url: string }>` — POST to `google-oauth-initiate` with `{ reconnect: true, accountId }`, then redirects browser to returned URL

All three use `supabase.functions.invoke()` to carry the Supabase JWT automatically.

---

## Frontend changes

### `AccountCard` component

**Current state:** reconnect is hardcoded to `google`. No disconnect or delete UI.

**Changes:**
1. **Reconnect button** — reads `provider` from the account row. Visible when `status === 'error' || status === 'revoked'`.
2. **Disconnect button** — visible when `status === 'active'`. Opens the disconnect modal.
3. **Delete button** — always visible (with appropriate warning styling). Opens a delete confirmation modal.

### New component: `DisconnectModal`

**Path:** `src/components/accounts/DisconnectModal.tsx`

Two choices presented to the user:
- **Keep my collected emails** (default, recommended) — `purgeMessages: false`
- **Delete my collected emails** — `purgeMessages: true`

Plus a cancel action. On confirm, calls `disconnectAccount(accountId, purgeMessages)`.

Copy:
- Heading: "Disconnect [email address]?"
- Subtext: "This will revoke Google's access and stop syncing. Your account and any collected emails can be kept or removed."
- Option A (radio, default selected): "Keep my collected emails — I may want to reconnect later"
- Option B (radio): "Delete my collected emails — remove all synced data for this account"
- Buttons: "Cancel" | "Disconnect"

### New component: `DeleteAccountModal`

**Path:** `src/components/accounts/DeleteAccountModal.tsx`

Single confirmation — no choice. Always purges.

Copy:
- Heading: "Delete [email address]?"
- Subtext: "This will permanently remove this connection and all collected emails. This cannot be undone."
- Buttons: "Cancel" | "Delete permanently"

### Mutations (React Query)

New hooks in `src/hooks/useAccounts.ts`:
- `useDisconnectAccount()` — invalidates `accounts` query on success
- `useDeleteAccount()` — invalidates `accounts` query on success

---

## RLS

No new RLS policies. All writes (UPDATE status, DELETE messages, DELETE connected_accounts) happen in the edge functions under the service role. The browser's SELECT-own policy is unchanged.

---

## Tests

**Component tests:**
- `DisconnectModal.test.tsx` — renders both radio options; keep is default; confirm disabled until selection confirmed; calls `disconnectAccount` with correct `purgeMessages`; cancel closes modal without calling service
- `DeleteAccountModal.test.tsx` — renders warning copy; confirm calls `deleteAccount`; cancel closes without action

**Service tests (`accounts.service.test.ts`):**
- `disconnectAccount` POSTs to correct endpoint with `{ accountId, purgeMessages }`
- `deleteAccount` POSTs to correct endpoint with `{ accountId }`
- `reconnectAccount` POSTs to initiate with `{ reconnect: true, accountId }` and redirects to returned URL

**Edge function unit tests (mocked fetch):**
- Disconnect: cross-user `accountId` returns 404
- Disconnect: Google `5xx` returns 502, does not update status or purge messages
- Disconnect: Google `400` proceeds with purge and status update
- Disconnect: Vault token missing → empty-token revoke → 400 → proceeds
- Delete: cross-user `accountId` returns 404
- Delete: Google `5xx` returns 502, does not delete row
- Reconnect callback: email mismatch on reconnect returns 400
- No token or account data logged at any severity level

---

## Acceptance criteria

1. A user with an active connection sees Disconnect and Delete buttons on `AccountCard`
2. Clicking Disconnect opens `DisconnectModal` with keep/purge radio options; keep is default
3. Confirming disconnect calls `google-account-disconnect`; the account card updates to `revoked` status
4. If purge was selected, messages for that account are gone from the `messages` table
5. If keep was selected, messages remain
6. A user with a `revoked` or `error` account sees a Reconnect button; clicking it redirects to Google with `prompt=consent`
7. After reconnect, the Google-returned email matches the account being reconnected; mismatch returns an error
8. After successful reconnect, the account returns to `active` status with a fresh token in Vault
9. Clicking Delete opens `DeleteAccountModal`; confirming removes the `connected_accounts` row and cascades messages
10. Google's revoke endpoint is called via POST (not GET); a terminal `4xx` does not block local cleanup; a `5xx` blocks cleanup and retains the Vault token
11. `UNIQUE (user_id, provider, email_address)` constraint is applied and replaces `connected_accounts_user_email_unique`
12. `google-oauth-callback` conflict target updated to `user_id,provider,email_address` and deployed alongside Migration 1
13. `vault_delete_secret` helper exists, grants execute to `service_role` only, and is called on both disconnect and delete
14. All five mandatory safety rules are satisfied (token isolation, read-only browser, PII containment, secrets out of git, untrusted content noted)

---

## Deployment order

1. Migration 1 (provider-aware unique key) — `npx supabase db push --linked` → confirm Remote column → `npm run gen:types`
2. Migration 2 (vault_delete_secret helper) — same gate
3. Deploy `google-oauth-callback` with updated conflict target (EU-26-8) — **must deploy before or alongside Migration 1 going live**
4. Deploy `google-account-disconnect` edge function
5. Deploy `google-account-delete` edge function
6. Deploy modified `google-oauth-initiate` edge function (reconnect support)
7. Frontend changes (AccountCard, DisconnectModal, DeleteAccountModal, hooks, service)

**Critical ordering note:** Steps 1 and 3 are coupled. The callback update must be deployed at the same time as the migration is applied, or new OAuth connections will fail in the window between them.

---

## Rollback

- **Migrations:** provider-aware key migration is reversible (drop new constraint, re-add old via new migration — never edit applied). `vault_delete_secret` is additive; drop with a new migration if needed.
- **Edge functions:** Supabase keeps prior versions; redeploy from git.
- **Frontend:** revert the PR.
- **Irreversible operations:** purge (disconnect with delete) and account delete permanently remove PII from `messages` and `connected_accounts`. These cannot be recovered from application code — only from Supabase PITR (point-in-time recovery). Before this epic ships, confirm PITR is enabled on the project and document the recovery path in the run sheet.

---

## Out of scope

- Microsoft / non-Google providers (Epic schema-standardization, deferred)
- Disconnect/delete for Drive accounts (Epic 04)
- Batched purge for very large accounts (noted as future work — acceptable limitation at demo scale)
- Collector race handling beyond the existing `status = 'active'` check (already sufficient)
