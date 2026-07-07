-- Bloat cleanup (system audit): complete_embedding_job was superseded by progress_embedding_job
-- in migration 20260706000001. The embedder (v5) calls only progress_embedding_job; nothing else
-- references the old RPC. Drop it so it can't be called and to keep the function surface minimal.
-- Idempotent. (Safe now — the resumable embedder has been live and draining for a full session.)
DROP FUNCTION IF EXISTS complete_embedding_job(
  uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer
);
