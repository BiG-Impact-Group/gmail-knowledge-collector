# Epic 03 — OAuth Lifecycle Design

**Date:** 2026-06-25  
**Slug:** oauth-lifecycle  
**Branch:** plan/oauth-lifecycle  
**Status:** Draft — awaiting Codex plan review  

---

## Revision history

| Rev | Date | Summary |
|-----|------|---------|
| 1 | 2026-06-25 | Initial spec from brainstorm |

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
| D3 | Always attempt Google revoke on disconnect and delete; treat any `4xx` as success | Leaving a live Google authorization dangling is worse than a redundant revoke call |
| D4 | Reconnect always sends `prompt=consent` | Guarantees a fresh refresh token; silent reuse risks returning the same dead grant |

---

## Architecture invariants (from CLAUDE.md)

- Edge functions are the only path to Google revoke and Vault operations — the browser never calls either directly
- Service layer is the only browser path to Supabase
- RLS: SELECT-own only on `connected_accounts`, no authenticated write policies
- Vault delete helper does not yet exist — must be created in this epic

---

## Data model changes

### Migration 1 — provider-aware unique key

**File:** `supabase/migrations/<timestamp>_provider_aware_unique_key.sql`

```sql
-- Drop the existing unique constraint (user_id, email_address)
-- Add new unique constraint (user_id, provider, email_address)
-- Idempotent: use DO-block guard (per migration 20260618000002 pattern)

DO $$
BEGIN
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

The existing Vault helpers (`vault_create_secret`, `vault_update_secret`, `vault_get_secret`, `vault_get_secret_id`) have no delete. This epic adds one.

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
```

The secret is keyed by `connected_account_id` in the existing pattern (e.g. `google_refresh_token_<account_id>`). The edge function resolves this name and calls the helper.

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
3. Fetch refresh token from Vault
4. Call `https://oauth2.googleapis.com/revoke?token=<refresh_token>` — treat any response (including `4xx`) as success; log the status
5. If `purgeMessages === true`: `DELETE FROM messages WHERE connected_account_id = accountId` (service role)
6. `UPDATE connected_accounts SET status = 'revoked', sync_cursor = NULL WHERE id = accountId` (service role)
7. Call `vault_delete_secret` to remove the refresh token
8. Return `200 { success: true }`

**Error handling:**
- Vault fetch fails (token already gone): proceed with revoke attempt using empty string — Google will 400, treat as success
- DB errors: return `500`

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
3. Fetch refresh token from Vault
4. Call Google revoke — treat `4xx` as success
5. `DELETE FROM connected_accounts WHERE id = accountId` — cascades to `messages` automatically (FK on delete cascade already exists)
6. Call `vault_delete_secret`
7. Return `200 { success: true }`

### Modified function: `google-oauth-initiate`

**Change:** Read `provider` from query param instead of hardcoding. For reconnect, the frontend passes `?provider=google&reconnect=true`. When `reconnect=true`, the state JWT carries a flag and the initiate function ensures `prompt=consent` is in the Google redirect URL.

Currently `prompt=consent` is already in the initiate flow for new connections — no change needed there. The reconnect path just needs to confirm the account being reconnected belongs to the calling user before redirecting.

**Reconnect input:** `GET /google-oauth-initiate?reconnect=true&accountId=<uuid>`

Additional step for reconnect: verify `connected_accounts` row ownership before redirecting. On successful callback, the existing upsert logic handles updating the token in Vault.

---

## Service layer changes

**File:** `src/services/accounts.service.ts`

New methods:
- `disconnectAccount(accountId: string, purgeMessages: boolean): Promise<void>` — POST to `google-account-disconnect`
- `deleteAccount(accountId: string): Promise<void>` — POST to `google-account-delete`
- `reconnectAccount(accountId: string): Promise<void>` — GET initiate with `reconnect=true&accountId=<uuid>` (redirects browser)

---

## Frontend changes

### `AccountCard` component

**Current state:** reconnect is hardcoded to `google`. No disconnect or delete UI.

**Changes:**
1. **Reconnect button** — reads `provider` from the account row, passes it through. Visible when `status === 'error' || status === 'revoked'`.
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

- `DisconnectModal.test.tsx` — renders both radio options, default is keep, confirm button disabled until option confirmed, calls `disconnectAccount` with correct `purgeMessages` value
- `DeleteAccountModal.test.tsx` — renders warning copy, confirm button calls `deleteAccount`
- `accounts.service.test.ts` — `disconnectAccount` and `deleteAccount` call the correct edge function endpoints with correct bodies

---

## Acceptance criteria

1. A user with an active connection sees Disconnect and Delete buttons on `AccountCard`
2. Clicking Disconnect opens `DisconnectModal` with keep/purge radio options; keep is default
3. Confirming disconnect calls `google-account-disconnect`; the account card updates to `revoked` status
4. If purge was selected, messages for that account are gone from the `messages` table
5. If keep was selected, messages remain
6. A user with a `revoked` or `error` account sees a Reconnect button; clicking it redirects to Google with `prompt=consent`
7. After reconnect, the account returns to `active` status with a fresh token in Vault
8. Clicking Delete opens `DeleteAccountModal`; confirming removes the `connected_accounts` row and cascades messages
9. Google's revoke endpoint is called on both disconnect and delete; a `4xx` response does not block local cleanup
10. `UNIQUE (user_id, provider, email_address)` constraint is applied and replaces the old `(user_id, email_address)` constraint
11. `vault_delete_secret` helper exists and is called on both disconnect and delete

---

## Deployment order

1. Migration 1 (provider-aware unique key) — `npx supabase db push --linked` → confirm Remote column → `npm run gen:types`
2. Migration 2 (vault_delete_secret helper) — same gate
3. Deploy `google-account-disconnect` edge function
4. Deploy `google-account-delete` edge function
5. Deploy modified `google-oauth-initiate` edge function
6. Frontend changes (AccountCard, DisconnectModal, DeleteAccountModal, hooks, service)

Frontend changes depend on the edge functions being deployed. Migrations must precede everything.

---

## Rollback

- Migrations: the provider-aware key migration is reversible (drop new constraint, re-add old). Create a new migration — never edit the applied one.
- Edge functions: Supabase keeps prior versions; redeploy the previous version from git.
- Frontend: revert the PR.
- The `vault_delete_secret` helper is additive; no rollback needed unless it causes problems.

---

## Out of scope

- Microsoft / non-Google providers (Epic schema-standardization, deferred)
- Disconnect/delete for Drive accounts (Epic 04)
- Any changes to the collector edge function (it already handles `invalid_grant` → `status = 'error'`)
