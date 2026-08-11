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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      assignments: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          org_id: string
          role: string | null
          task_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          org_id: string
          role?: string | null
          task_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          org_id?: string
          role?: string | null
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_org_id_contact_id_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_org_id_task_id_fkey"
            columns: ["org_id", "task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      change_log: {
        Row: {
          action: string
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          org_id: string
          source: Database["public"]["Enums"]["change_source"]
          transcript: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          org_id: string
          source?: Database["public"]["Enums"]["change_source"]
          transcript?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          org_id?: string
          source?: Database["public"]["Enums"]["change_source"]
          transcript?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "change_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          meta: Json
          name: string
          org_id: string
          phone: string | null
          trade: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          meta?: Json
          name: string
          org_id: string
          phone?: string | null
          trade?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          meta?: Json
          name?: string
          org_id?: string
          phone?: string | null
          trade?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          calendar_id: string
          created_at: string
          date: string
          id: string
          label: string | null
          org_id: string
        }
        Insert: {
          calendar_id: string
          created_at?: string
          date: string
          id?: string
          label?: string | null
          org_id: string
        }
        Update: {
          calendar_id?: string
          created_at?: string
          date?: string
          id?: string
          label?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_org_id_calendar_id_fkey"
            columns: ["org_id", "calendar_id"]
            isOneToOne: false
            referencedRelation: "work_calendars"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "holidays_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_connections: {
        Row: {
          connected_at: string
          email: string | null
          id: string
          is_primary: boolean
          last_refreshed_at: string | null
          org_id: string
          provider: Database["public"]["Enums"]["oauth_provider"]
          provider_user_id: string | null
          refresh_token_encrypted: string | null
          scopes: string[]
          status: Database["public"]["Enums"]["connection_status"]
          user_id: string
        }
        Insert: {
          connected_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          last_refreshed_at?: string | null
          org_id: string
          provider: Database["public"]["Enums"]["oauth_provider"]
          provider_user_id?: string | null
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: Database["public"]["Enums"]["connection_status"]
          user_id: string
        }
        Update: {
          connected_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          last_refreshed_at?: string | null
          org_id?: string
          provider?: Database["public"]["Enums"]["oauth_provider"]
          provider_user_id?: string | null
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: Database["public"]["Enums"]["connection_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          company_name: string | null
          created_at: string
          id: string
          name: string
          timezone: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          id?: string
          name: string
          timezone?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string
          id?: string
          name?: string
          timezone?: string
        }
        Relationships: []
      }
      outbound_messages: {
        Row: {
          body: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          contact_id: string | null
          created_at: string
          error: string | null
          id: string
          idempotency_key: string | null
          ms_event_id: string | null
          ms_message_id: string | null
          org_id: string
          sent_at: string | null
          status: Database["public"]["Enums"]["message_status"]
          subject: string | null
          task_id: string | null
        }
        Insert: {
          body?: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          contact_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string | null
          ms_event_id?: string | null
          ms_message_id?: string | null
          org_id: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          subject?: string | null
          task_id?: string | null
        }
        Update: {
          body?: string | null
          channel?: Database["public"]["Enums"]["message_channel"]
          contact_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string | null
          ms_event_id?: string | null
          ms_message_id?: string | null
          org_id?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          subject?: string | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outbound_messages_org_id_contact_id_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "outbound_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_messages_org_id_task_id_fkey"
            columns: ["org_id", "task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      projects: {
        Row: {
          address: string | null
          client_name: string | null
          color: string | null
          created_at: string
          id: string
          job_number: string | null
          meta: Json
          name: string
          org_id: string
          starts_on: string | null
          status: Database["public"]["Enums"]["project_status"]
        }
        Insert: {
          address?: string | null
          client_name?: string | null
          color?: string | null
          created_at?: string
          id?: string
          job_number?: string | null
          meta?: Json
          name: string
          org_id: string
          starts_on?: string | null
          status?: Database["public"]["Enums"]["project_status"]
        }
        Update: {
          address?: string | null
          client_name?: string | null
          color?: string | null
          created_at?: string
          id?: string
          job_number?: string | null
          meta?: Json
          name?: string
          org_id?: string
          starts_on?: string | null
          status?: Database["public"]["Enums"]["project_status"]
        }
        Relationships: [
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      task_deps: {
        Row: {
          created_at: string
          dep_type: Database["public"]["Enums"]["dep_type"]
          id: string
          lag_days: number
          org_id: string
          predecessor_id: string
          successor_id: string
        }
        Insert: {
          created_at?: string
          dep_type?: Database["public"]["Enums"]["dep_type"]
          id?: string
          lag_days?: number
          org_id: string
          predecessor_id: string
          successor_id: string
        }
        Update: {
          created_at?: string
          dep_type?: Database["public"]["Enums"]["dep_type"]
          id?: string
          lag_days?: number
          org_id?: string
          predecessor_id?: string
          successor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_deps_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_deps_org_id_predecessor_id_fkey"
            columns: ["org_id", "predecessor_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "task_deps_org_id_successor_id_fkey"
            columns: ["org_id", "successor_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      tasks: {
        Row: {
          created_at: string
          duration_days: number
          end_date: string | null
          id: string
          is_milestone: boolean
          meta: Json
          name: string
          notes: string | null
          org_id: string
          project_id: string
          sort_order: number
          start_date: string | null
          status: Database["public"]["Enums"]["task_status"]
          trade: string | null
        }
        Insert: {
          created_at?: string
          duration_days?: number
          end_date?: string | null
          id?: string
          is_milestone?: boolean
          meta?: Json
          name: string
          notes?: string | null
          org_id: string
          project_id: string
          sort_order?: number
          start_date?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          trade?: string | null
        }
        Update: {
          created_at?: string
          duration_days?: number
          end_date?: string | null
          id?: string
          is_milestone?: boolean
          meta?: Json
          name?: string
          notes?: string | null
          org_id?: string
          project_id?: string
          sort_order?: number
          start_date?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          trade?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_org_id_project_id_fkey"
            columns: ["org_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      work_calendars: {
        Row: {
          created_at: string
          id: string
          name: string
          org_id: string
          working_days: number[]
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          org_id: string
          working_days?: number[]
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          org_id?: string
          working_days?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "work_calendars_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_plan_writes: {
        Args: {
          p_org_id: string
          p_ops: Json
          p_source?: Database["public"]["Enums"]["change_source"]
          p_transcript?: string | null
        }
        Returns: Json
      }
      apply_task_moves: {
        Args: {
          p_moves: Json
          p_source?: Database["public"]["Enums"]["change_source"]
          p_transcript?: string | null
        }
        Returns: number
      }
      auth_org_ids: { Args: never; Returns: string[] }
      create_org_with_owner: {
        Args: {
          p_name: string
          p_company_name?: string | null
          p_timezone?: string
        }
        Returns: string
      }
    }
    Enums: {
      change_source: "voice" | "ui" | "system"
      connection_status: "active" | "needs_reauth"
      dep_type: "FS" | "SS" | "FF" | "SF"
      message_channel: "email" | "calendar"
      message_status: "draft" | "queued" | "sent" | "failed"
      oauth_provider: "microsoft" | "google"
      org_role: "owner" | "admin" | "member"
      project_status: "active" | "complete" | "on_hold"
      task_status: "planned" | "active" | "blocked" | "done"
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
    Enums: {
      change_source: ["voice", "ui", "system"],
      connection_status: ["active", "needs_reauth"],
      dep_type: ["FS", "SS", "FF", "SF"],
      message_channel: ["email", "calendar"],
      message_status: ["draft", "queued", "sent", "failed"],
      oauth_provider: ["microsoft", "google"],
      org_role: ["owner", "admin", "member"],
      project_status: ["active", "complete", "on_hold"],
      task_status: ["planned", "active", "blocked", "done"],
    },
  },
} as const
