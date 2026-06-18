import { useInfiniteQuery } from '@tanstack/react-query'
import { getMessages } from '@/services/messages.service'

export function useMessages(connectedAccountId?: string) {
  return useInfiniteQuery({
    queryKey: ['messages', connectedAccountId ?? 'all'],
    queryFn: ({ pageParam }) => getMessages(connectedAccountId, pageParam as number),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 200 ? allPages.length * 200 : undefined,
    initialPageParam: 0,
    refetchInterval: 60_000,
  })
}
