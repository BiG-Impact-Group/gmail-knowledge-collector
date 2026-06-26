import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { listDocuments, getDocument } from '@/services/documents.service'

export function useDocuments(params?: { accountId?: string }) {
  const accountId = params?.accountId
  return useInfiniteQuery({
    queryKey: ['documents', accountId ?? 'all'],
    queryFn: ({ pageParam }) => listDocuments({ page: pageParam as number, accountId }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length : undefined,
    initialPageParam: 0,
    refetchInterval: 60_000,
  })
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => getDocument(id!),
    enabled: !!id,
  })
}
