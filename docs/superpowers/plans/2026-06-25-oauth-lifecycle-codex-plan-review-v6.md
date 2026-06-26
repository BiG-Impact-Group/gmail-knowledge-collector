Category: RPC exposure  
Severity: Critical  
Finding: Migration 3 adds write-capable RPCs but does not specify revoking default `PUBLIC` execute, while the plan’s invariant says browser writes must not exist ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:190>), [RLS invariant](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:324>)). Supabase RPC functions are API-callable unless execute is locked down.  
Recommendation: For `collect_account_messages`, `lifecycle_disconnect`, and `lifecycle_delete`, explicitly `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`. Keep them service-role only.

Category: Deployment/race safety  
Severity: Critical  
Finding: Deployment order exposes `google-account-disconnect` and `google-account-delete` before deploying the modified collector ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:386>), [collector deploy later](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:389>)). During that window, the live collector still writes via independent `.upsert()` calls ([backfill](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:223>), [incremental](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:312>)), so lifecycle locks do not protect purges from reinserts.  
Recommendation: Deploy Migration 3, then modified `gmail-collector`, then lifecycle edge functions/frontend. Alternatively pause cron until collector and lifecycle endpoints are both updated.

Category: Migration validity  
Severity: Critical  
Finding: The planned RPC snippets show explicit `BEGIN; ... COMMIT;` transaction control inside the RPC design ([plan](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:194>), [COMMIT](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:202>)). PostgreSQL functions called via PostgREST RPC should not control transactions; the RPC call itself is the transaction boundary.  
Recommendation: Define real `CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql` bodies with `BEGIN ... END` block syntax only, no transaction `BEGIN/COMMIT`, and rely on the single RPC transaction for `pg_advisory_xact_lock`.

quality score: 6/10 needs revision