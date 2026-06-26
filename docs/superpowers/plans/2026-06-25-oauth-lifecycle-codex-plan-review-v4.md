**Finding 1**

Category: integration / database  
Severity: critical  
Finding: The collector race is still not fully closed. The plan says a DB-level `WHERE EXISTS status = 'active'` guard is enough and “no advisory lock needed” in [oauth-lifecycle-design.md](/Users/caleb/Documents/Claude%20Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:186), but the current collector writes are independent `.upsert()` calls in [gmail-collector/index.ts](/Users/caleb/Documents/Claude%20Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:223) and [gmail-collector/index.ts](/Users/caleb/Documents/Claude%20Code/gmail-knowledge-collector-planner-oauth-lifecycle/supabase/functions/gmail-collector/index.ts:312). A guarded insert that starts before the disconnect status flip can still commit after the purge unless the collector and disconnect share a row/advisory lock or a transactional RPC. That can reintroduce purged PII or write after disconnect.

Recommendation: Add a real shared critical section: a service-role RPC or advisory lock keyed by `connected_account.id` used by collector writes/cursor updates and by disconnect/delete cleanup. Revoke/Vault work can happen before the DB lock; the final status flip plus purge/delete must be transactional with the same lock. Add a race test with collector paused between Gmail fetch and DB write while disconnect purges.

**Finding 2**

Category: database / ordering  
Severity: critical  
Finding: The deployment order still misses `npm run gen:types` after Migration 1b. Step 4 only says “confirm Remote column” in [oauth-lifecycle-design.md](/Users/caleb/Documents/Claude%20Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/superpowers/plans/2026-06-25-oauth-lifecycle-design.md:349), but the project brief requires paired type generation for every migration in [project-brief.md](/Users/caleb/Documents/Claude%20Code/gmail-knowledge-collector-planner-oauth-lifecycle/docs/project-brief.md:27).

Recommendation: Add `npm run gen:types` after Migration 1b as well, even if the generated diff is empty.

Quality score: 8/10  
Top risks: purge/write race under concurrent collector run; migration/type gate drift.  
Status: needs revision.