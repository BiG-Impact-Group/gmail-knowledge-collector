import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type Message = Tables<'messages'>
export type MessageListItem = Pick<Message, 'id' | 'from_address' | 'subject' | 'snippet' | 'internal_date' | 'connected_account_id'>

export async function getMessages(connectedAccountId?: string, offset = 0): Promise<MessageListItem[]> {
  const base = supabase
    .from('messages')
    .select('id, from_address, subject, snippet, internal_date, connected_account_id')

  const filtered = connectedAccountId
    ? base.eq('connected_account_id', connectedAccountId)
    : base

  const { data, error } = await filtered
    .order('internal_date', { ascending: false })
    .range(offset, offset + 199)

  if (error) throw error
  return data
}

export async function getMessage(id: string): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    // PGRST116 = no rows returned
    if ((error as { code?: string }).code === 'PGRST116') return null
    throw error
  }
  return data
}
