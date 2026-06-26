import { supabase } from '@/lib/supabase'

// A single retrieved passage with its source citation. Mirrors the `search` edge function's
// `match_chunks` row shape. `web_view_link` may be null or untrusted — the UI only renders it as a
// link after validating it parses to an https URL.
export interface SearchResult {
  document_id: string
  document_name: string
  web_view_link: string | null
  content: string
  chunk_index: number
  similarity: number
}

// Invoke the in-boundary `search` edge function with the user's JWT (carried by the supabase
// client). Returns the typed top-K passages. Throws on error. The service layer is the only
// Supabase touchpoint.
export async function searchKnowledge(query: string, limit?: number): Promise<SearchResult[]> {
  const body: { query: string; limit?: number } = { query }
  if (limit !== undefined) body.limit = limit

  const { data, error } = await supabase.functions.invoke<{ results: SearchResult[] }>(
    'search',
    { body },
  )
  if (error) throw error
  return data?.results ?? []
}
