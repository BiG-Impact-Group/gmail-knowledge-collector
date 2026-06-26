Category: OAuth callback token lifecycle  
Severity: Critical  
Finding: After Google issues a new `refresh_token`, the plan still discards it on several callback abort paths: userinfo failure, account update/upsert failure, Vault lookup/write failure, and explicitly mismatch revoke `5xx`. That can leave a live Google grant with no Vault secret or account row to retry cleanup.  
Recommendation: Enforce a single invariant for every newly issued refresh token: it is either stored under a valid tracked account, successfully revoked, or durably quarantined in Vault with a cleanup record for retry. Do not return while dropping an unrevoked token. Add tests for userinfo failure, DB/Vault failure, and mismatch revoke failure.

Category: Concurrency / lifecycle race  
Severity: Critical  
Finding: Disconnect/delete and reconnect callback are not serialized. A delete/disconnect can fetch and revoke the old token while a reconnect callback writes a fresh token for the same `account.id`; the lifecycle function can then delete the row/secret or mark revoked without ever revoking the fresh Google grant.  
Recommendation: Add a per-account lifecycle lease/version that both lifecycle functions and OAuth callback participate in. Callback must refuse or quarantine/revoke fresh tokens while a lifecycle operation is pending; lifecycle completion must only delete/mark the account if no newer OAuth token write occurred.

Final: quality score 8/10, needs revision.