export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      connected_accounts: {
        Row: {
          id: string
          user_id: string
          provider: string
          email_address: string
          status: string
          granted_scopes: string | null
          sync_cursor: string | null
          last_synced_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          provider?: string
          email_address: string
          status?: string
          granted_scopes?: string | null
          sync_cursor?: string | null
          last_synced_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          provider?: string
          email_address?: string
          status?: string
          granted_scopes?: string | null
          sync_cursor?: string | null
          last_synced_at?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          connected_account_id: string
          user_id: string
          gmail_message_id: string
          thread_id: string | null
          from_address: string | null
          to_addresses: string | null
          subject: string | null
          snippet: string | null
          internal_date: string | null
          body_text: string | null
          body_html: string | null
          label_ids: string[] | null
          fetched_at: string
        }
        Insert: {
          id?: string
          connected_account_id: string
          user_id: string
          gmail_message_id: string
          thread_id?: string | null
          from_address?: string | null
          to_addresses?: string | null
          subject?: string | null
          snippet?: string | null
          internal_date?: string | null
          body_text?: string | null
          body_html?: string | null
          label_ids?: string[] | null
          fetched_at?: string
        }
        Update: {
          id?: string
          connected_account_id?: string
          user_id?: string
          gmail_message_id?: string
          thread_id?: string | null
          from_address?: string | null
          to_addresses?: string | null
          subject?: string | null
          snippet?: string | null
          internal_date?: string | null
          body_text?: string | null
          body_html?: string | null
          label_ids?: string[] | null
          fetched_at?: string
        }
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
