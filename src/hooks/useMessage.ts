import { useQuery } from '@tanstack/react-query'
import { getMessage } from '@/services/messages.service'

export function useMessage(id: string | null) {
  return useQuery({
    queryKey: ['message', id],
    queryFn: () => getMessage(id!),
    enabled: !!id,
  })
}
