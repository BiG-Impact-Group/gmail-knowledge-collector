-- oauth_nonces: one-time tokens for OAuth CSRF/replay protection.
-- Each nonce is stored before the auth redirect and atomically consumed (deleted)
-- by the callback. A second request with the same state parameter will find no row
-- and be rejected, closing the 5-minute replay window that existed when only JWT
-- expiry was checked.
-- Service-role only — RLS enabled with no authenticated policies = deny-all for browser.
CREATE TABLE IF NOT EXISTS oauth_nonces (
  nonce       uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  expires_at  timestamptz NOT NULL
);

ALTER TABLE oauth_nonces ENABLE ROW LEVEL SECURITY;

-- Index supports periodic cleanup of expired rows.
CREATE INDEX IF NOT EXISTS oauth_nonces_expires_at_idx ON oauth_nonces (expires_at);
