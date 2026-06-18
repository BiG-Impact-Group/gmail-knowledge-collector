import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { getAccounts } from '@/services/accounts.service'

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: getAccounts,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })
}
