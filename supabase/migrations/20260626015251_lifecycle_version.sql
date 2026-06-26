-- Migration 0: Add lifecycle_version column to connected_accounts
-- Used by lifecycle_disconnect/lifecycle_delete RPCs to detect reconnect races

ALTER TABLE public.connected_accounts
  ADD COLUMN IF NOT EXISTS lifecycle_version integer NOT NULL DEFAULT 0;
