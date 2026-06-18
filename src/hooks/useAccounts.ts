import { useQuery } from '@tanstack/react-query'
import { getAccounts } from '@/services/accounts.service'

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: getAccounts,
  })
}
