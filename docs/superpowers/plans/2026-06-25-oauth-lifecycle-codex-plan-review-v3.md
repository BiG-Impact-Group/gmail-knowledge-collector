**Remaining Critical Findings**

1. **Category:** security  
   **Severity:** critical  
   **Finding:** Work unit `#34` / EU-26-8 leaves a live wrong-account Google grant on reconnect mismatch. The plan says callback validates the returned email and returns `400` on mismatch, but that validation can only happen after token exchange and userinfo fetch in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/google-oauth-callback/index.ts:101>). At that point `tokens.refresh_token` may already exist. Returning `400` without revoking it leaves account B authorized but untracked in `connected_accounts` or Vault.  
   **Recommendation:** In the reconnect mismatch branch, revoke the newly issued refresh token via Google revoke POST body before returning. Add tests for mismatch revoke success and revoke `5xx`/network failure.

2. **Category:** integration  
   **Severity:** critical  
   **Finding:** Work units `#29` and `#36` still have a collector purge race. The plan’s status re-check before collector upserts is not atomic. Current writes happen in [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:223>) and [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:312>). A check can pass, then `google-account-disconnect` can mark `connected_accounts.status = 'revoked'` and purge `messages`, then the collector can still upsert purged PII.  
   **Recommendation:** Use a DB-side atomic guard or lock: e.g. RPC that inserts/updates messages only from `connected_accounts WHERE id = ... AND status = 'active'`, or an advisory lock shared by collector, disconnect, and delete.

3. **Category:** security  
   **Severity:** critical  
   **Finding:** `google-account-disconnect` has contradictory and unsafe failure semantics. Step 4 sets `connected_accounts.status = 'revoked'` before revoke, while step 5 returns `502` on Google `5xx`/network and retains the Vault token. But the test plan says Google `5xx` “does not update status” in [oauth plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:307>), and UI work unit `#33` only shows Disconnect for `active`/`error`, not `revoked`. A failed revoke can strand a live Google grant with no non-destructive retry path.  
   **Recommendation:** Either do not set `revoked` until revoke succeeds, or allow disconnect retry for `revoked` rows with retained Vault tokens. Align tests, UI visibility, and edge behavior.

4. **Category:** database  
   **Severity:** critical  
   **Finding:** Work unit `#28` adds public function `vault_delete_secret`, but deployment order only runs `npm run gen:types` after Migration 1a and 1b, not after Migration 2. This violates the project invariant that type generation is paired with every migration. Current [database.types.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/src/types/database.types.ts:128>) has no generated functions.  
   **Recommendation:** Add `npm run gen:types` immediately after Migration 2 and commit `src/types/database.types.ts` with the migration.

Overall plan quality: **7/10**.

Top 3 risks: wrong-account reconnect creates an untracked live Google grant; purge can be undone by an in-flight collector write; failed disconnect can strand a retained token with no retry UX.

Status: **needs revision before implementation**.