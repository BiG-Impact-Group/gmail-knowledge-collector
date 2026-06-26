import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { getAccounts, disconnectAccount, deleteAccount } from '@/services/accounts.service'

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: getAccounts,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })
}

/** Invalidates accounts, messages, and individual message caches after disconnect/delete */
function useAccountsInvalidation() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['accounts'] })
    queryClient.invalidateQueries({ queryKey: ['messages'] })
    queryClient.invalidateQueries({ queryKey: ['message'] })
  }
}

export function useDisconnectAccount() {
  const invalidate = useAccountsInvalidation()
  return useMutation({
    mutationFn: ({ accountId, purgeMessages }: { accountId: string; purgeMessages: boolean }) =>
      disconnectAccount(accountId, purgeMessages),
    onSuccess: invalidate,
  })
}

export function useDeleteAccount() {
  const invalidate = useAccountsInvalidation()
  return useMutation({
    mutationFn: ({ accountId }: { accountId: string }) => deleteAccount(accountId),
    onSuccess: invalidate,
  })
}
