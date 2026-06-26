-- Epic 07 (code review v1): harden match_chunks against null inputs.
-- I1: p_limit=NULL made LEAST(GREATEST(NULL,1),10)=NULL → Postgres LIMIT NULL = unbounded, bypassing
--     the clamp for a direct authenticated caller. COALESCE to the default. Also reject a NULL
--     embedding (undefined ordering) by returning no rows. Isolation is still RLS; this just enforces
--     the limit contract for direct RPC callers.
CREATE OR REPLACE FUNCTION match_chunks(
  p_query_embedding extensions.vector(384),
  p_limit integer
) RETURNS TABLE (
  document_id uuid, document_name text, web_view_link text,
  content text, chunk_index integer, similarity double precision
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions
AS $$
BEGIN
  IF p_query_embedding IS NULL THEN
    RETURN;  -- no embedding → no results (never an unbounded/undefined scan)
  END IF;
  PERFORM set_config('hnsw.ef_search', '100', true);
  RETURN QUERY
  SELECT c.document_id, d.name, d.web_view_link, c.content, c.chunk_index,
         (-(c.embedding <#> p_query_embedding))::double precision AS similarity
  FROM public.chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
  WHERE d.content_status = 'extracted'
    AND c.source_version = d.drive_modified_time
  ORDER BY c.embedding <#> p_query_embedding
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 10);
END;
$$;

REVOKE ALL ON FUNCTION match_chunks(extensions.vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_chunks(extensions.vector, integer) FROM anon;
GRANT EXECUTE ON FUNCTION match_chunks(extensions.vector, integer) TO authenticated;
