import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type Message = Tables<'messages'>

export async function getMessages(): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('internal_date', { ascending: false })

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
