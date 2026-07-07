-- Hybrid retrieval for match_chunks (smoke-test finding: title-style queries fail).
--
-- WHY: pure vector search ranks passages by semantic similarity of CONTENT only — it never sees
-- document NAMES. Query "the independent" surfaced a transcript that repeats the phrase
-- "The Independent Woman" instead of the document literally named "The Independent.txt".
-- Entity/title lookups need a lexical signal; conversational queries still want vectors.
--
-- DESIGN: three ranked legs fused with Reciprocal Rank Fusion (RRF, k=60):
--   1. vector    — HNSW inner-product over chunk embeddings (weight 1.0), as before
--   2. lexical   — full-text search over chunk content, ts_rank_cd (weight 1.0)
--   3. name      — full-text match on the DOCUMENT NAME; earliest chunks of the named doc first
--                  (weight 3.0 — a title query should decisively pin the named document)
-- Final ranking caps results at 2 chunks per document so one doc can't crowd out the rest.
-- `similarity` still reports the vector similarity of the chunk (UI display unchanged);
-- ORDERING is by fused score.
--
-- The signature gains p_query (raw query text for the lexical legs). The old 2-arg overload is
-- dropped so PostgREST never faces overload ambiguity; the search edge function deploys with the
-- new named args in the same change. SECURITY INVOKER — per-user isolation stays RLS-enforced.

-- Lexical indexes (idempotent). Simple 'english' config; corpus is English transcripts/docs.
CREATE INDEX IF NOT EXISTS chunks_content_fts
  ON chunks USING gin (to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS documents_name_fts
  ON documents USING gin (to_tsvector('english', name));

DROP FUNCTION IF EXISTS match_chunks(extensions.vector, integer);

CREATE OR REPLACE FUNCTION match_chunks(
  p_query_embedding extensions.vector(384),
  p_query text,
  p_limit integer
) RETURNS TABLE (
  document_id uuid, document_name text, web_view_link text,
  content text, chunk_index integer, similarity double precision
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 10);
  v_pool  constant integer := 30;   -- candidates per leg before fusion
  v_k     constant integer := 60;   -- RRF constant
  v_q tsquery;
BEGIN
  IF p_query_embedding IS NULL THEN
    RETURN;  -- no embedding → no results (never an unbounded/undefined scan)
  END IF;
  -- Build the lexical query; stopword-only input (e.g. "the") yields an empty tsquery → NULL
  -- and the lexical legs are skipped (pure vector behavior).
  IF p_query IS NOT NULL AND length(btrim(p_query)) > 0 THEN
    v_q := websearch_to_tsquery('english', p_query);
    IF numnode(v_q) = 0 THEN v_q := NULL; END IF;
  END IF;

  PERFORM set_config('hnsw.ef_search', '100', true);

  RETURN QUERY
  WITH vec AS (
    SELECT c.id AS cid,
           row_number() OVER (ORDER BY c.embedding <#> p_query_embedding) AS r
    FROM public.chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
    WHERE d.content_status = 'extracted'
      AND c.source_version = d.drive_modified_time
    ORDER BY c.embedding <#> p_query_embedding
    LIMIT v_pool
  ),
  lex AS (
    SELECT c.id AS cid,
           row_number() OVER (
             ORDER BY ts_rank_cd(to_tsvector('english', c.content), v_q) DESC, c.id
           ) AS r
    FROM public.chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
    WHERE v_q IS NOT NULL
      AND d.content_status = 'extracted'
      AND c.source_version = d.drive_modified_time
      AND to_tsvector('english', c.content) @@ v_q
    ORDER BY ts_rank_cd(to_tsvector('english', c.content), v_q) DESC, c.id
    LIMIT v_pool
  ),
  nm AS (
    -- Chunks of documents whose NAME matches the query; a doc's earliest chunks rank first.
    SELECT c.id AS cid,
           row_number() OVER (ORDER BY c.document_id, c.chunk_index) AS r
    FROM public.chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
    WHERE v_q IS NOT NULL
      AND d.content_status = 'extracted'
      AND c.source_version = d.drive_modified_time
      AND to_tsvector('english', d.name) @@ v_q
    ORDER BY c.document_id, c.chunk_index
    LIMIT v_pool
  ),
  fused AS (
    SELECT s.cid, sum(s.score) AS score
    FROM (
      SELECT vec.cid, 1.0 / (v_k + vec.r) AS score FROM vec
      UNION ALL
      SELECT lex.cid, 1.0 / (v_k + lex.r) FROM lex
      UNION ALL
      SELECT nm.cid, 3.0 / (v_k + nm.r) FROM nm
    ) s
    GROUP BY s.cid
  ),
  ranked AS (
    SELECT c.document_id AS r_document_id,
           d.name AS r_document_name,
           d.web_view_link AS r_web_view_link,
           c.content AS r_content,
           c.chunk_index AS r_chunk_index,
           (-(c.embedding <#> p_query_embedding))::double precision AS r_similarity,
           f.score AS r_score,
           row_number() OVER (PARTITION BY c.document_id ORDER BY f.score DESC, c.chunk_index) AS doc_rank
    FROM fused f
    JOIN public.chunks c ON c.id = f.cid
    JOIN public.documents d ON d.id = c.document_id AND d.user_id = c.user_id
  )
  SELECT rk.r_document_id, rk.r_document_name, rk.r_web_view_link,
         rk.r_content, rk.r_chunk_index, rk.r_similarity
  FROM ranked rk
  WHERE rk.doc_rank <= 2                     -- diversity: at most 2 chunks per document
  ORDER BY rk.r_score DESC, rk.r_similarity DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION match_chunks(extensions.vector, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_chunks(extensions.vector, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION match_chunks(extensions.vector, text, integer) TO authenticated;
