import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type Document = Tables<'documents'>
export type DocumentListItem = Pick<
  Document,
  'id' | 'name' | 'mime_type' | 'content_status' | 'drive_modified_time' | 'connected_account_id'
>

const PAGE_SIZE = 50

// Paginated list, ordered by drive_modified_time DESC NULLS LAST to match the UI sort
// and the documents_user_id_modified_idx index. `page` is 0-based.
export async function listDocuments(params: {
  page: number
  accountId?: string
}): Promise<{ documents: DocumentListItem[]; hasMore: boolean }> {
  const { page, accountId } = params
  const from = page * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  const base = supabase
    .from('documents')
    .select('id, name, mime_type, content_status, drive_modified_time, connected_account_id')

  const filtered = accountId
    ? base.eq('connected_account_id', accountId)
    : base

  const { data, error } = await filtered
    .order('drive_modified_time', { ascending: false, nullsFirst: false })
    .range(from, to)

  if (error) throw error
  return { documents: data ?? [], hasMore: (data?.length ?? 0) === PAGE_SIZE }
}

export async function getDocument(id: string): Promise<Document | null> {
  const { data, error } = await supabase
    .from('documents')
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

// Initiate Drive OAuth — performs the window.location redirect itself (same shape as
// initiateOAuth in accounts.service.ts), NOT returning { url }.
export async function initiateGoogleDriveOAuth(params?: {
  reconnect?: boolean
  accountId?: string
}): Promise<void> {
  const body = params?.reconnect && params.accountId
    ? { reconnect: true, accountId: params.accountId }
    : undefined
  const { data, error } = await supabase.functions.invoke<{ url: string }>(
    'google-drive-oauth-initiate',
    body ? { body } : undefined,
  )
  if (error) throw error
  if (data?.url) {
    window.location.href = data.url
  }
}
