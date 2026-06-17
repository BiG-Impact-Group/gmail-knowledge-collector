import { useQuery } from '@tanstack/react-query'
import { getMessages } from '@/services/messages.service'

export function useMessages() {
  return useQuery({
    queryKey: ['messages'],
    queryFn: getMessages,
    refetchInterval: 60_000,
  })
}
