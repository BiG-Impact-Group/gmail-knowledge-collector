**Findings**

1. **Category:** integration  
   **Severity:** critical  
   **Finding:** Reconnect can reactivate an account that the collector cannot sync. Disconnect sets only `status = 'revoked'` and `sync_cursor = NULL` in `connected_accounts` ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:169>)). Existing collector chooses backfill vs incremental from `backfill_complete`, not `sync_cursor` ([gmail-collector](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:182>)). If `backfill_complete = true`, reconnect can produce `users/me/history?startHistoryId=null` ([gmail-collector](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:278>)).  
   **Recommendation:** Add explicit reconnect state handling: reset `backfill_complete`, `backfill_page_token`, `backfill_start_history_id`, and `sync_cursor`, or set a fresh Gmail `historyId` during callback. Test reconnect after both keep-data and purge disconnects.

2. **Category:** integration  
   **Severity:** critical  
   **Finding:** The collector-race claim is false. The plan says `gmail-collector` re-checks `status = 'active'` before writing ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:177>)), but current code only filters active accounts once ([gmail-collector](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:142>)) and later upserts into `messages` without a status guard ([backfill write](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:223>), [incremental write](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:312>)). A purge can be followed by reinserts from an in-flight collector run.  
   **Recommendation:** Add a real guard: mark revoked before purge and update collector writes/cursor updates to re-check `connected_accounts.status = 'active'`, or add a lease/lock around collection and lifecycle mutations.

3. **Category:** security  
   **Severity:** critical  
   **Finding:** `google-account-delete` deletes the `connected_accounts` row before deleting the Vault secret ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:196>)). If `vault_delete_secret(account.id)` fails after the row is gone, the raw account-id Vault secret is orphaned with no UI retry path. Disconnect has a similar partial-state risk after purge/status update ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:168>)).  
   **Recommendation:** Revoke Google, delete the Vault secret, then delete/update local rows. If any local cleanup step fails, leave enough state to retry. Prefer a service-role RPC transaction for local DB cleanup plus Vault deletion where feasible.

4. **Category:** ordering  
   **Severity:** critical  
   **Finding:** The migration/callback rollout is not actually safe. The deployment order applies Migration 1 before deploying the callback ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:326>)), while current callback still uses `onConflict: 'user_id,email_address'` ([callback](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-callback/index.ts:156>)). Deploying the callback first also fails unless the new unique constraint already exists.  
   **Recommendation:** Split Migration 1: first add `UNIQUE (user_id, provider, email_address)` while keeping `connected_accounts_user_email_unique`, deploy callback EU-26-8, then drop the old unique constraint in a second migration.

5. **Category:** security  
   **Severity:** important  
   **Finding:** Vault lookup failure is treated as “token already gone” and converted into an empty-token revoke ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:173>)). That conflates “no row found” with Vault/RPC/permission failure. It can report local success without proving the Google grant was revoked.  
   **Recommendation:** Distinguish `data === null && !error` from RPC errors. Return 500/502 and preserve state on Vault errors. If the secret is genuinely missing, surface a specific “local disconnect only/manual Google revoke may be needed” outcome.

6. **Category:** completeness  
   **Severity:** important  
   **Finding:** Purge/delete only invalidates the `accounts` query ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:270>)), but message lists and details are cached under `['messages', ...]` and `['message', id]` ([useMessages](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/src/hooks/useMessages.ts:6>), [useMessage](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/src/hooks/useMessage.ts:6>)). The UI can keep showing purged PII until refetch/reload.  
   **Recommendation:** Invalidate `accounts`, all `messages` queries, and affected `message` detail queries after disconnect purge and delete. Reset selected message state in the email page if the selected account/message was removed.

7. **Category:** testing  
   **Severity:** important  
   **Finding:** The plan calls for edge function unit tests, but the repo only has Jest configured for `src/**/*` ([jest config](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/jest.config.ts:18>), [package](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/package.json:11>)). Edge functions use `Deno.serve` and remote Deno imports ([initiate](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-initiate/index.ts:43>)), so the proposed tests are not executable as written.  
   **Recommendation:** Add a Deno test command or refactor edge-function handlers into injectable pure functions that Jest can import. Include missing cases: invalid JWT, malformed UUID/body, CORS preflight, Vault delete failure, network failure, and terminal `401/403`.

8. **Category:** completeness  
   **Severity:** important  
   **Finding:** Users with `status = 'error'` cannot disconnect while keeping collected mail. The plan shows Reconnect for `error || revoked` and Disconnect only for `active` ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:236>)). That leaves a broken account with a Vault token but no keep-data disconnect path.  
   **Recommendation:** Allow Disconnect for `active` and `error` accounts. Treat invalid/terminal revoke responses as success, delete the Vault token, and set `revoked`.

9. **Category:** safety  
   **Severity:** important  
   **Finding:** New browser-invoked edge functions do not specify CORS, method gating, or schema validation. Existing `google-oauth-initiate` has explicit CORS handling ([initiate](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-initiate/index.ts:44>)), but the new `google-account-disconnect` and `google-account-delete` work units only define happy-path JSON bodies ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:152>)).  
   **Recommendation:** Define shared edge-function request handling: `POST` only, `OPTIONS` support, Zod/body validation, UUID validation, and service-role writes that include both `id` and `user_id` filters where possible.

10. **Category:** rollback  
    **Severity:** important  
    **Finding:** Rollback says the provider-aware key is reversible ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:340>)), but re-adding `UNIQUE (user_id, email_address)` can fail once provider-distinct duplicate rows exist. Rollback also omits callback conflict-target coordination.  
    **Recommendation:** Add rollback prechecks for duplicate `(user_id, email_address)` rows, a data remediation decision, and exact ordering for callback redeploy vs constraint rollback. Keep the PITR run sheet as a release gate, not a note.

11. **Category:** completeness  
    **Severity:** important  
    **Finding:** The plan is not decomposed into builder-ready work units/GitHub issues, despite project process requiring that ([dev-rules](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/dev-rules.md:69>)). The handoff file’s implementation queue is empty and points at `2026-06-26-oauth-lifecycle.md`, which is not the reviewed plan file ([handoff](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/handoffs/oauth-lifecycle.md:10>)).  
    **Recommendation:** Add an issue decomposition table covering migrations, callback EU-26-8, new edge functions, initiate reconnect support, service/hooks, UI, tests, deployment, and rollback docs. Fix the handoff path.

12. **Category:** performance  
    **Severity:** suggestion  
    **Finding:** Batched purge is declared out of scope ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:351>)). The `messages.connected_account_id` index exists ([schema](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/migrations/20260617000001_initial_schema.sql:81>)), so demo-scale deletes are likely fine, but large public-sector mailboxes can still hit edge-function timeouts or long locks.  
    **Recommendation:** Keep single-delete for demo only, but document a row-count threshold and a batched/async purge fallback before production use.

**Summary**

Overall plan quality: **6/10**. It is substantially improved and covers the right surface area, but it still needs revision before implementation.

Top 3 risks:
1. Reconnect and disconnect can leave `connected_accounts` in states the collector handles incorrectly.
2. Token/Vault cleanup can become unretryable after partial local deletion.
3. The provider-aware unique-key migration and callback deploy are not safely ordered.

Safety rules are explicitly named, but token isolation is not fully satisfied until orphan-secret and Vault-error handling are fixed. Browser read-only, PII containment, secrets-out-of-git, and untrusted-content note are addressed at the plan level.