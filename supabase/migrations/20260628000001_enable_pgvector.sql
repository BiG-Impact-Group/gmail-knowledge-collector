-- Epic 06 (Migration 1): enable the pgvector extension for embedding storage/search.
-- Installed into the `extensions` schema (Supabase convention) so the `vector` type and operator
-- classes (e.g. vector_ip_ops) are schema-qualified everywhere. Idempotent via IF NOT EXISTS.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
