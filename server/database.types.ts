export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

type DiscordConnectionRow = {
  id: string
  discord_user_id: string
  discord_username: string
  discord_avatar: string | null
  encrypted_access_token: string
  encrypted_refresh_token: string | null
  token_expires_at: string | null
  created_at: string
  updated_at: string
}

export type ClanApplicationRow = {
  id: string
  application_number: string
  discord_user_id: string
  discord_username: string
  in_game_name: string
  age_group: string
  sex: string
  device: string
  games: string[]
  willing_to_use_clan_tag: boolean
  play_frequency: string
  previous_clan: string
  previous_clan_leaving_reason: string
  facebook_profile_url: string
  discovery_source: string
  discovery_source_other: string | null
  already_joined_discord: boolean
  discord_membership_verified: boolean | null
  reason_for_joining: string
  consent_accurate: boolean
  consent_rules: boolean
  consent_false_information: boolean
  consent_processing: boolean
  status: string
  reviewed_by: string | null
  reviewed_at: string | null
  decision_reason: string | null
  discord_onboarding_status: string
  assigned_discord_roles: string[]
  discord_onboarded_at: string | null
  discord_onboarding_error: string | null
  ai_evaluation_status: string
  ai_evaluation_error: string | null
  ai_evaluated_at: string | null
  messenger_notification_status: string
  messenger_notification_error: string | null
  messenger_notified_at: string | null
  messenger_message_ids: string[]
  excel_sync_status: string
  excel_synced_at: string | null
  excel_sync_error: string | null
  submitted_at: string
  updated_at: string
}

type AdminUserRow = {
  discord_user_id: string
  display_name: string
  is_active: boolean
  created_at: string
}

type DiscordOnboardingLogRow = {
  id: string
  application_id: string
  discord_user_id: string
  guild_id: string
  assigned_roles: string[]
  status: string
  error_message: string | null
  created_at: string
}

export type AiEvaluationRow = {
  id: string
  application_id: string
  score: number
  recommendation: string
  confidence: number
  motivation_score: number
  teamwork_score: number
  activity_score: number
  clan_commitment_score: number
  consistency_score: number
  communication_score: number
  strengths: string[]
  concerns: string[]
  summary: string
  moderation_flagged: boolean
  moderation_categories: Json
  model: string
  prompt_version: string
  created_at: string
}

type MessengerAdminRow = {
  id: string
  facebook_psid: string
  display_name: string
  role: string
  can_approve: boolean
  can_reject: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

type MessengerNotificationLogRow = {
  id: string
  application_id: string
  messenger_admin_id: string | null
  recipient_psid: string
  status: string
  message_ids: string[]
  error_message: string | null
  created_at: string
}

type MessengerWebhookEventRow = {
  id: string
  external_event_id: string
  sender_psid: string
  event_type: string
  payload: Json
  processing_status: string
  error_message: string | null
  received_at: string
  processed_at: string | null
}

export type ApplicationDecisionRow = {
  id: string
  application_id: string
  decision: string
  decision_reason: string | null
  decision_source: string
  decided_by: string
  decided_at: string
}

export type ExcelExportRow = {
  id: string
  export_type: string
  filters: Json
  record_count: number
  generated_by: string
  storage_path: string | null
  status: string
  error_message: string | null
  created_at: string
}

export type ClanBanRow = {
  id: string
  discord_user_id: string | null
  in_game_name: string | null
  in_game_name_normalized: string | null
  facebook_profile_url: string | null
  facebook_profile_url_normalized: string | null
  reason: string
  is_active: boolean
  banned_by: string
  created_at: string
  deactivated_at: string | null
  deactivated_by: string | null
}

export type SecurityAuditLogRow = {
  id: string
  actor_type: string
  actor_id: string | null
  action: string
  application_id: string | null
  target_type: string | null
  target_id: string | null
  outcome: string
  details: Json
  ip_address_hash: string | null
  user_agent_hash: string | null
  request_id: string | null
  created_at: string
}

type RateLimitBucketRow = {
  key_hash: string
  attempt_count: number
  window_started_at: string
  blocked_until: string | null
  updated_at: string
}

export type Database = {
  public: {
    Tables: {
      discord_connections: {
        Row: DiscordConnectionRow
        Insert: Omit<DiscordConnectionRow, 'id' | 'created_at' | 'updated_at'> & {
          id?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<DiscordConnectionRow>
        Relationships: []
      }
      clan_applications: {
        Row: ClanApplicationRow
        Insert: Omit<
          ClanApplicationRow,
          | 'id'
          | 'submitted_at'
          | 'updated_at'
          | 'reviewed_by'
          | 'reviewed_at'
          | 'decision_reason'
          | 'discord_membership_verified'
          | 'discord_onboarding_status'
          | 'assigned_discord_roles'
          | 'discord_onboarded_at'
          | 'discord_onboarding_error'
          | 'ai_evaluation_status'
          | 'ai_evaluation_error'
          | 'ai_evaluated_at'
          | 'messenger_notification_status'
          | 'messenger_notification_error'
          | 'messenger_notified_at'
          | 'messenger_message_ids'
          | 'excel_sync_status'
          | 'excel_synced_at'
          | 'excel_sync_error'
        > & {
          id?: string
          submitted_at?: string
          updated_at?: string
          reviewed_by?: string | null
          reviewed_at?: string | null
          decision_reason?: string | null
          discord_membership_verified?: boolean | null
          discord_onboarding_status?: string
          assigned_discord_roles?: string[]
          discord_onboarded_at?: string | null
          discord_onboarding_error?: string | null
          ai_evaluation_status?: string
          ai_evaluation_error?: string | null
          ai_evaluated_at?: string | null
          messenger_notification_status?: string
          messenger_notification_error?: string | null
          messenger_notified_at?: string | null
          messenger_message_ids?: string[]
          excel_sync_status?: string
          excel_synced_at?: string | null
          excel_sync_error?: string | null
        }
        Update: Partial<ClanApplicationRow>
        Relationships: [
          {
            foreignKeyName: 'clan_applications_discord_user_id_fkey'
            columns: ['discord_user_id']
            isOneToOne: false
            referencedRelation: 'discord_connections'
            referencedColumns: ['discord_user_id']
          },
        ]
      }
      admin_users: {
        Row: AdminUserRow
        Insert: Omit<AdminUserRow, 'created_at'> & { created_at?: string }
        Update: Partial<AdminUserRow>
        Relationships: []
      }
      discord_onboarding_logs: {
        Row: DiscordOnboardingLogRow
        Insert: Omit<DiscordOnboardingLogRow, 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<DiscordOnboardingLogRow>
        Relationships: [
          {
            foreignKeyName: 'discord_onboarding_logs_application_id_fkey'
            columns: ['application_id']
            isOneToOne: false
            referencedRelation: 'clan_applications'
            referencedColumns: ['id']
          },
        ]
      }
      ai_evaluations: {
        Row: AiEvaluationRow
        Insert: Omit<AiEvaluationRow, 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<AiEvaluationRow>
        Relationships: [
          {
            foreignKeyName: 'ai_evaluations_application_id_fkey'
            columns: ['application_id']
            isOneToOne: false
            referencedRelation: 'clan_applications'
            referencedColumns: ['id']
          },
        ]
      }
      messenger_admins: {
        Row: MessengerAdminRow
        Insert: Omit<MessengerAdminRow, 'id' | 'created_at' | 'updated_at'> & {
          id?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<MessengerAdminRow>
        Relationships: []
      }
      messenger_notification_logs: {
        Row: MessengerNotificationLogRow
        Insert: Omit<MessengerNotificationLogRow, 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<MessengerNotificationLogRow>
        Relationships: [
          {
            foreignKeyName: 'messenger_notification_logs_application_id_fkey'
            columns: ['application_id']
            isOneToOne: false
            referencedRelation: 'clan_applications'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'messenger_notification_logs_messenger_admin_id_fkey'
            columns: ['messenger_admin_id']
            isOneToOne: false
            referencedRelation: 'messenger_admins'
            referencedColumns: ['id']
          },
        ]
      }
      messenger_webhook_events: {
        Row: MessengerWebhookEventRow
        Insert: Omit<MessengerWebhookEventRow, 'id' | 'received_at' | 'processed_at'> & {
          id?: string
          received_at?: string
          processed_at?: string | null
        }
        Update: Partial<MessengerWebhookEventRow>
        Relationships: []
      }
      application_decisions: {
        Row: ApplicationDecisionRow
        Insert: Omit<ApplicationDecisionRow, 'id' | 'decided_at'> & {
          id?: string
          decided_at?: string
        }
        Update: Partial<ApplicationDecisionRow>
        Relationships: [
          {
            foreignKeyName: 'application_decisions_application_id_fkey'
            columns: ['application_id']
            isOneToOne: false
            referencedRelation: 'clan_applications'
            referencedColumns: ['id']
          },
        ]
      }
      excel_exports: {
        Row: ExcelExportRow
        Insert: Omit<ExcelExportRow, 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<ExcelExportRow>
        Relationships: []
      }
      clan_bans: {
        Row: ClanBanRow
        Insert: Omit<
          ClanBanRow,
          'id' | 'in_game_name_normalized' | 'facebook_profile_url_normalized' | 'created_at' | 'deactivated_at' | 'deactivated_by'
        > & {
          id?: string
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
        }
        Update: Partial<Omit<ClanBanRow, 'in_game_name_normalized' | 'facebook_profile_url_normalized'>>
        Relationships: []
      }
      security_audit_logs: {
        Row: SecurityAuditLogRow
        Insert: Omit<SecurityAuditLogRow, 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: 'security_audit_logs_application_id_fkey'
            columns: ['application_id']
            isOneToOne: false
            referencedRelation: 'clan_applications'
            referencedColumns: ['id']
          },
        ]
      }
      rate_limit_buckets: {
        Row: RateLimitBucketRow
        Insert: RateLimitBucketRow
        Update: Partial<RateLimitBucketRow>
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: {
      decide_clan_application: {
        Args: {
          p_application_id: string
          p_decision: string
          p_reason: string | null
          p_source: string
          p_decided_by: string
        }
        Returns: ClanApplicationRow[]
      }
      consume_rate_limit: {
        Args: {
          p_key_hash: string
          p_limit: number
          p_window_seconds: number
          p_block_seconds: number
        }
        Returns: Array<{
          allowed: boolean
          remaining: number
          retry_after_seconds: number
        }>
      }
    }
    Enums: Record<never, never>
    CompositeTypes: Record<never, never>
  }
}
