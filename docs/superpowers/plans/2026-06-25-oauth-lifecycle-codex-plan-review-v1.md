**Findings**

1. **Category:** database  
   **Severity:** critical  
   **Finding:** `Migration 1 — provider-aware unique key` drops `connected_accounts_user_id_email_address_key`, but the real constraint is `connected_accounts_user_email_unique` in [20260617000001_initial_schema.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/migrations/20260617000001_initial_schema.sql:15>). The old `(user_id, email_address)` constraint would remain, so Drive/Gmail same-email coexistence still fails.  
   **Recommendation:** Drop the actual constraint name, optionally guard for both names, then add `connected_accounts_user_id_provider_email_address_key`.

2. **Category:** ordering  
   **Severity:** critical  
   **Finding:** The plan changes the unique key but omits `google-oauth-callback`. Current callback still upserts with `onConflict: 'user_id,email_address'` in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-callback/index.ts:156>). After the old unique constraint is removed, new OAuth callbacks can fail.  
   **Recommendation:** Add a callback work unit and deploy it with the migration, updating conflict target to `user_id,provider,email_address`.

3. **Category:** security  
   **Severity:** critical  
   **Finding:** `Migration 2 — vault_delete_secret` creates a `SECURITY DEFINER` function but does not revoke public execute. Existing Vault helpers explicitly revoke public access and grant only `service_role` in [20260617000002_vault_helpers.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/migrations/20260617000002_vault_helpers.sql:44>).  
   **Recommendation:** Add `REVOKE ALL ON FUNCTION vault_delete_secret(text) FROM PUBLIC;` and grant execute only to `service_role`.

4. **Category:** security  
   **Severity:** critical  
   **Finding:** Revoke failure handling is under-specified. The plan deletes the Vault token after revoke, but if Google returns `5xx` or the network fails, the grant may remain live and the app loses the refresh token needed to retry.  
   **Recommendation:** Treat only `2xx` and terminal `4xx` as success. For network/`5xx`, retain the token and retry, or add a `revocation_pending` path.

5. **Category:** security  
   **Severity:** important  
   **Finding:** Revoke uses `https://oauth2.googleapis.com/revoke?token=<refresh_token>` in the plan. Query-string tokens can leak through logs.  
   **Recommendation:** POST to the revoke endpoint with `application/x-www-form-urlencoded` body. Log only status/error class.

6. **Category:** completeness  
   **Severity:** important  
   **Finding:** The plan says the Vault secret pattern is `google_refresh_token_<account_id>`, but current code stores and reads secrets using raw `account.id` in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-callback/index.ts:168>) and [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:157>).  
   **Recommendation:** Specify `secret_name: account.id`, or include a safe migration to a prefixed naming scheme across callback, collector, disconnect, and delete.

7. **Category:** integration  
   **Severity:** important  
   **Finding:** Reconnect is not bound to the selected account. Current state has only `user_id`, `nonce`, and `exp` in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-callback/index.ts:21>). A user could click reconnect for account A but authorize account B, causing the callback to upsert B while A remains revoked.  
   **Recommendation:** Put `reconnect_account_id` and provider in signed state, verify ownership in callback, and require the returned Google email to match the selected row.

8. **Category:** integration  
   **Severity:** important  
   **Finding:** The plan says `reconnectAccount` uses GET with query params, but current `google-oauth-initiate` allows POST/OPTIONS and relies on Supabase JWT auth through `functions.invoke` in [accounts.service.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/src/services/accounts.service.ts:24>). A direct browser GET will not carry the JWT.  
   **Recommendation:** Keep authenticated POST returning `{ url }`, with reconnect data in the body, or implement explicit authenticated fetch in the service layer.

9. **Category:** integration  
   **Severity:** important  
   **Finding:** `google-account-disconnect` can race with `gmail-collector`. The collector loads active accounts once in [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:142>) and later upserts messages. A purge could complete, then an in-flight collector run could reinsert messages.  
   **Recommendation:** Add an account-level lifecycle lock or re-check `status = 'active'` before collector writes. Do not keep collector changes out of scope.

10. **Category:** testing  
    **Severity:** important  
    **Finding:** Tests cover only modals and service calls. Missing: edge auth tests, cross-user `accountId` denial, purge/keep DB effects, Vault-missing behavior, revoke `4xx/5xx`, no token logging, callback conflict target, and reconnect email mismatch.  
    **Recommendation:** Add edge-function/unit tests with mocked `fetch`, plus migration assertions for constraints and function privileges.

11. **Category:** rollback  
    **Severity:** important  
    **Finding:** Rollback says revert code, but this epic performs irreversible deletes from `messages`, `connected_accounts`, and Vault. Reverting the PR will not restore PII or refresh tokens.  
    **Recommendation:** Add backup/PITR confirmation, lifecycle audit logs, and a recovery runbook for mistaken purges/deletes.

12. **Category:** safety  
    **Severity:** important  
    **Finding:** The plan explicitly mentions token isolation and read-only browser writes, but does not add explicit checks for PII containment, secrets out of git, or the untrusted email-content note.  
    **Recommendation:** Add safety acceptance checks covering all five mandatory rules.

13. **Category:** performance  
    **Severity:** suggestion  
    **Finding:** Purge/delete are unbounded deletes in an edge request. `messages.connected_account_id` is indexed, but large accounts can still hit timeouts or long locks.  
    **Recommendation:** Quantify expected row counts. For large accounts, use a batched RPC/background cleanup path.

**Summary**

Overall plan quality: **5/10**. The UX direction is coherent, but the token lifecycle and migration/callback coordination need revision before build.

Top 3 risks:

1. Publicly executable `vault_delete_secret` could allow Vault secret deletion.
2. Provider-aware unique migration breaks OAuth callback unless callback conflict handling is updated and deployed in order.
3. Revoke/delete handling can lose the only token needed to revoke a still-live Google grant.

Status: **needs revision before implementation**.