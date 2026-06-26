export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      connected_accounts: {
        Row: {
          backfill_complete: boolean
          backfill_page_token: string | null
          backfill_start_history_id: string | null
          created_at: string
          email_address: string
          granted_scopes: string | null
          id: string
          last_synced_at: string | null
          lifecycle_version: number
          provider: string
          status: string
          sync_cursor: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          backfill_complete?: boolean
          backfill_page_token?: string | null
          backfill_start_history_id?: string | null
          created_at?: string
          email_address: string
          granted_scopes?: string | null
          id?: string
          last_synced_at?: string | null
          lifecycle_version?: number
          provider?: string
          status?: string
          sync_cursor?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          backfill_complete?: boolean
          backfill_page_token?: string | null
          backfill_start_history_id?: string | null
          created_at?: string
          email_address?: string
          granted_scopes?: string | null
          id?: string
          last_synced_at?: string | null
          lifecycle_version?: number
          provider?: string
          status?: string
          sync_cursor?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      documents: {
        Row: {
          connected_account_id: string
          content_status: string
          created_at: string
          drive_file_id: string
          drive_modified_time: string | null
          fetched_at: string
          id: string
          mime_type: string
          name: string
          size_bytes: number | null
          text_content: string | null
          updated_at: string
          user_id: string
          web_view_link: string | null
        }
        Insert: {
          connected_account_id: string
          content_status?: string
          created_at?: string
          drive_file_id: string
          drive_modified_time?: string | null
          fetched_at?: string
          id?: string
          mime_type: string
          name: string
          size_bytes?: number | null
          text_content?: string | null
          updated_at?: string
          user_id: string
          web_view_link?: string | null
        }
        Update: {
          connected_account_id?: string
          content_status?: string
          created_at?: string
          drive_file_id?: string
          drive_modified_time?: string | null
          fetched_at?: string
          id?: string
          mime_type?: string
          name?: string
          size_bytes?: number | null
          text_content?: string | null
          updated_at?: string
          user_id?: string
          web_view_link?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_user_account_fk"
            columns: ["user_id", "connected_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      messages: {
        Row: {
          body_html: string | null
          body_text: string | null
          connected_account_id: string
          fetched_at: string
          from_address: string | null
          gmail_message_id: string
          id: string
          internal_date: string | null
          label_ids: string[] | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_addresses: string | null
          user_id: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          connected_account_id: string
          fetched_at?: string
          from_address?: string | null
          gmail_message_id: string
          id?: string
          internal_date?: string | null
          label_ids?: string[] | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string | null
          user_id: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          connected_account_id?: string
          fetched_at?: string
          from_address?: string | null
          gmail_message_id?: string
          id?: string
          internal_date?: string | null
          label_ids?: string[] | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_connected_account_id_fkey"
            columns: ["connected_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_user_id_connected_account_fk"
            columns: ["user_id", "connected_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      oauth_nonces: {
        Row: {
          expires_at: string
          nonce: string
          user_id: string
        }
        Insert: {
          expires_at: string
          nonce: string
          user_id: string
        }
        Update: {
          expires_at?: string
          nonce?: string
          user_id?: string
        }
        Relationships: []
      }
      processing_jobs: {
        Row: {
          attempts: number
          claimed_at: string | null
          created_at: string
          document_id: string
          id: string
          last_error: string | null
          source_type: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          document_id: string
          id?: string
          last_error?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          document_id?: string
          id?: string
          last_error?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_jobs_user_document_fk"
            columns: ["user_id", "document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_processing_jobs: {
        Args: {
          p_limit: number
          p_max_attempts: number
          p_stale_seconds: number
        }
        Returns: {
          attempts: number
          claimed_at: string
          connected_account_id: string
          document_id: string
          drive_file_id: string
          drive_modified_time: string
          job_id: string
          lifecycle_version: number
          mime_type: string
          user_id: string
        }[]
      }
      collect_account_documents: {
        Args: {
          p_account_id: string
          p_backfill_complete: boolean
          p_backfill_page_token: string
          p_documents: Json
          p_expected_version: number
          p_sync_cursor: string
        }
        Returns: undefined
      }
      collect_account_messages: {
        Args: { p_account_id: string; p_messages: Json; p_new_cursor: string }
        Returns: undefined
      }
      complete_processing_job: {
        Args: {
          p_attempts: number
          p_claimed_at: string
          p_drive_modified_time: string
          p_error: string
          p_job_id: string
          p_lifecycle_version: number
          p_max_attempts: number
          p_outcome: string
          p_text: string
        }
        Returns: undefined
      }
      delete_account_documents: {
        Args: {
          p_account_id: string
          p_expected_version: number
          p_file_ids: string[]
        }
        Returns: undefined
      }
      enqueue_processing_jobs: { Args: never; Returns: undefined }
      get_vault_secret: { Args: { secret_name: string }; Returns: string }
      get_vault_secret_id: { Args: { secret_name: string }; Returns: string }
      lifecycle_delete: {
        Args: {
          p_account_id: string
          p_expected_version: number
          p_user_id: string
        }
        Returns: boolean
      }
      lifecycle_disconnect: {
        Args: {
          p_account_id: string
          p_expected_version: number
          p_purge: boolean
          p_user_id: string
        }
        Returns: boolean
      }
      reset_account_documents: {
        Args: { p_account_id: string; p_expected_version: number }
        Returns: undefined
      }
      vault_create_secret: {
        Args: { description?: string; name: string; secret: string }
        Returns: string
      }
      vault_delete_secret: { Args: { secret_name: string }; Returns: undefined }
      vault_update_secret: {
        Args: { new_secret: string; secret_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
