-- Epic 07 (basic-rag): match_chunks — in-boundary semantic search RPC.
--
-- SECURITY INVOKER: the function runs under the CALLER's privileges, so the chunks SELECT-own
-- RLS policy (Epic 06) scopes results to the caller's own rows automatically. The `search` edge
-- function calls this with the caller's JWT (anon-key client + Authorization header), NOT the
-- service role — so a caller can never read another user's chunks. RLS is the isolation boundary;
-- there is deliberately NO p_user_id parameter to widen scope.
--
-- The edge function computes the query embedding in-boundary (gte-small, 384-dim) and passes it
-- here; this function performs the vector match in Postgres. `<#>` is negative inner product; for
-- normalized embeddings ascending order = most similar. similarity = -(embedding <#> q) so higher
-- is better.
--
-- Freshness: only current, extracted content is returned (content_status='extracted' AND the
-- chunk's source_version equals the document's drive_modified_time) so stale/superseded passages
-- are never surfaced (Epic 06 contract). p_limit is clamped to 1..10.

CREATE OR REPLACE FUNCTION match_chunks(
  p_query_embedding extensions.vector(384),
  p_limit integer
) RETURNS TABLE (
  document_id uuid,
  document_name text,
  web_view_link text,
  content text,
  chunk_index integer,
  similarity double precision
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions
AS $$
BEGIN
  PERFORM set_config('hnsw.ef_search', '100', true);
  RETURN QUERY
  SELECT c.document_id,
         d.name,
         d.web_view_link,
         c.content,
         c.chunk_index,
         (-(c.embedding <#> p_query_embedding))::double precision AS similarity
  FROM public.chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
  WHERE d.content_status = 'extracted'
    AND c.source_version = d.drive_modified_time
  ORDER BY c.embedding <#> p_query_embedding
  LIMIT LEAST(GREATEST(p_limit, 1), 10);
END;
$$;

-- INVOKER + RLS enforces per-user isolation: only `authenticated` may execute it, and each call
-- runs under that caller's own RLS. Do NOT grant to anon. service_role is not needed.
REVOKE ALL ON FUNCTION match_chunks(extensions.vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_chunks(extensions.vector, integer) FROM anon;
GRANT EXECUTE ON FUNCTION match_chunks(extensions.vector, integer) TO authenticated;
