import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'
import type { Provider } from '@/types/provider'

export type ConnectedAccount = Tables<'connected_accounts'>

export async function getAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
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
