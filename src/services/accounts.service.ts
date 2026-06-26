import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'
import type { Provider } from '@/types/provider'

export type ConnectedAccount = Pick<
  Tables<'connected_accounts'>,
  'id' | 'provider' | 'email_address' | 'status' | 'granted_scopes' | 'last_synced_at' | 'created_at' | 'updated_at'
>

export async function getAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, provider, email_address, status, granted_scopes, last_synced_at, created_at, updated_at')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data as ConnectedAccount[]
}

export async function initiateOAuth(provider: Provider): Promise<void> {
  if (provider !== 'google') {
    throw new Error(`Provider '${provider}' not implemented`)
  }
  const { data, error } = await supabase.functions.invoke<{ url: string }>('google-oauth-initiate')
  if (error) throw error
  if (data?.url) {
    window.location.href = data.url
  }
}

export async function disconnectAccount(accountId: string, purgeMessages: boolean): Promise<void> {
  const { error } = await supabase.functions.invoke('google-account-disconnect', {
    body: { accountId, purgeMessages },
  })
  if (error) throw error
}

export async function deleteAccount(accountId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('google-account-delete', {
    body: { accountId },
  })
  if (error) throw error
}

export async function reconnectAccount(accountId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ url: string }>('google-oauth-initiate', {
    body: { reconnect: true, accountId },
  })
  if (error) throw error
  if (data?.url) {
    window.location.href = data.url
  }
}
