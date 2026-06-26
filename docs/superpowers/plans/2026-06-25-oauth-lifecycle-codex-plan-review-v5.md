Category: Concurrency / Data Safety  
Severity: Critical  
Finding: The advisory-lock fix is not implementable as stated. `pg_advisory_xact_lock` only protects work inside the same DB transaction, but the current Supabase Edge pattern uses separate PostgREST calls for each `.upsert()`, `.update()`, and `.delete()`. A standalone lock RPC would release before subsequent writes, so the collector purge/reinsert race remains.  
Recommendation: Add transactional DB RPCs or a direct Postgres transaction path. The collector write batch must acquire the lock, re-check `status = 'active'`, write messages, and update cursor in the same transaction. Disconnect/delete cleanup must acquire the same lock and status/purge/delete in one transaction.

Category: OAuth Lifecycle / Token Safety  
Severity: Critical  
Finding: Reconnect callback is not coordinated with disconnect/delete. An in-flight reconnect can receive and store a fresh refresh token while delete/disconnect is revoking an older token; the cleanup can then delete the newly stored Vault secret without revoking that new Google grant, leaving a live untracked authorization. Reconnect can also upsert/recreate a row after a delete race.  
Recommendation: Put reconnect callback token storage under the same account lifecycle guard. For reconnect, update exactly `reconnect_account_id`, not an email-based upsert, and reject/revoke the new token if the account is missing, deleted, or its lifecycle generation changed.

Final: quality score 7/10, needs revision.