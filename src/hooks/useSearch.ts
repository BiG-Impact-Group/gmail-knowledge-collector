import { useMutation } from '@tanstack/react-query'
import { searchKnowledge, type SearchResult } from '@/services/search.service'

// Search is user-initiated (a submit), not a passive query → useMutation, not useQuery.
// `data` holds the results array; consumers also get isPending / error / reset.
export function useSearch() {
  return useMutation<SearchResult[], Error, { query: string; limit?: number }>({
    mutationFn: ({ query, limit }) => searchKnowledge(query, limit),
  })
}
