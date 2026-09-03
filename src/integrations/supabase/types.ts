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
      activity_log: {
        Row: {
          action: string
          actor: string
          actor_user_id: string | null
          agency_id: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          meta: Json
        }
        Insert: {
          action: string
          actor?: string
          actor_user_id?: string | null
          agency_id: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json
        }
        Update: {
          action?: string
          actor?: string
          actor_user_id?: string | null
          agency_id?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agencies: {
        Row: {
          address: string | null
          contact_email: string | null
          contact_phone: string | null
          country: string
          created_at: string
          id: string
          logo_url: string | null
          name: string
          plan: string
          registration_no: string | null
          slug: string | null
          timezone: string
          updated_at: string
          website: string | null
        }
        Insert: {
          address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          id?: string
          logo_url?: string | null
          name: string
          plan?: string
          registration_no?: string | null
          slug?: string | null
          timezone?: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          id?: string
          logo_url?: string | null
          name?: string
          plan?: string
          registration_no?: string | null
          slug?: string | null
          timezone?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      agency_entitlements: {
        Row: {
          agency_id: string
          created_at: string
          effective_plan: string
          notes: string | null
          overrides: Json
          requested_plan: string | null
          source: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          effective_plan?: string
          notes?: string | null
          overrides?: Json
          requested_plan?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          effective_plan?: string
          notes?: string | null
          overrides?: Json
          requested_plan?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_entitlements_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: true
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          agency_id: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["app_role"]
          status: string
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          agency_id: string
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          role: Database["public"]["Enums"]["app_role"]
          status?: string
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          agency_id?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_invitations_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_settings: {
        Row: {
          agency_id: string
          ai_custom_instructions: string
          ai_emoji: boolean
          ai_language: string
          ai_name: string
          ai_personality: string
          ai_reply_length: string
          ai_tone: string
          autonomy_cooldown_minutes: number
          autonomy_mode: string
          business_hours: Json
          created_at: string
          deposit_fixed_myr: number | null
          deposit_percent: number | null
          deposit_rule: string
          id: string
          kb_auto_use: boolean
          kb_escalate_when_unknown: boolean
          kb_max_articles: number
          kb_strict_mode: boolean
          notify_booking: boolean
          notify_daily_summary: boolean
          notify_email: boolean
          notify_followup_due: boolean
          notify_hot_lead: boolean
          notify_new_lead: boolean
          notify_whatsapp: boolean
          plan: string
          plan_status: string
          quotation_validity_days: number
          renews_at: string | null
          seats: number
          updated_at: string
          voice_controls: Json
          voice_language: string
          voice_name: string | null
          voice_persona: string
        }
        Insert: {
          agency_id: string
          ai_custom_instructions?: string
          ai_emoji?: boolean
          ai_language?: string
          ai_name?: string
          ai_personality?: string
          ai_reply_length?: string
          ai_tone?: string
          autonomy_cooldown_minutes?: number
          autonomy_mode?: string
          business_hours?: Json
          created_at?: string
          deposit_fixed_myr?: number | null
          deposit_percent?: number | null
          deposit_rule?: string
          id?: string
          kb_auto_use?: boolean
          kb_escalate_when_unknown?: boolean
          kb_max_articles?: number
          kb_strict_mode?: boolean
          notify_booking?: boolean
          notify_daily_summary?: boolean
          notify_email?: boolean
          notify_followup_due?: boolean
          notify_hot_lead?: boolean
          notify_new_lead?: boolean
          notify_whatsapp?: boolean
          plan?: string
          plan_status?: string
          quotation_validity_days?: number
          renews_at?: string | null
          seats?: number
          updated_at?: string
          voice_controls?: Json
          voice_language?: string
          voice_name?: string | null
          voice_persona?: string
        }
        Update: {
          agency_id?: string
          ai_custom_instructions?: string
          ai_emoji?: boolean
          ai_language?: string
          ai_name?: string
          ai_personality?: string
          ai_reply_length?: string
          ai_tone?: string
          autonomy_cooldown_minutes?: number
          autonomy_mode?: string
          business_hours?: Json
          created_at?: string
          deposit_fixed_myr?: number | null
          deposit_percent?: number | null
          deposit_rule?: string
          id?: string
          kb_auto_use?: boolean
          kb_escalate_when_unknown?: boolean
          kb_max_articles?: number
          kb_strict_mode?: boolean
          notify_booking?: boolean
          notify_daily_summary?: boolean
          notify_email?: boolean
          notify_followup_due?: boolean
          notify_hot_lead?: boolean
          notify_new_lead?: boolean
          notify_whatsapp?: boolean
          plan?: string
          plan_status?: string
          quotation_validity_days?: number
          renews_at?: string | null
          seats?: number
          updated_at?: string
          voice_controls?: Json
          voice_language?: string
          voice_name?: string | null
          voice_persona?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_settings_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: true
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_tasks: {
        Row: {
          agency_id: string
          approval_reason: string | null
          approved_at: string | null
          approved_by: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          input: Json
          kind: string
          lead_id: string | null
          minutes_saved: number
          origin: string
          output: Json | null
          plan: Json
          priority: string
          requires_approval: boolean
          scheduled_for: string | null
          started_at: string | null
          status: string
          steps: Json
          summary: string | null
          title: string
          updated_at: string
          worker_key: string
        }
        Insert: {
          agency_id: string
          approval_reason?: string | null
          approved_at?: string | null
          approved_by?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input?: Json
          kind: string
          lead_id?: string | null
          minutes_saved?: number
          origin?: string
          output?: Json | null
          plan?: Json
          priority?: string
          requires_approval?: boolean
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          steps?: Json
          summary?: string | null
          title: string
          updated_at?: string
          worker_key: string
        }
        Update: {
          agency_id?: string
          approval_reason?: string | null
          approved_at?: string | null
          approved_by?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input?: Json
          kind?: string
          lead_id?: string | null
          minutes_saved?: number
          origin?: string
          output?: Json | null
          plan?: Json
          priority?: string
          requires_approval?: boolean
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          steps?: Json
          summary?: string | null
          title?: string
          updated_at?: string
          worker_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_tasks_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_workers: {
        Row: {
          agency_id: string
          autonomy: string
          created_at: string
          description: string
          id: string
          is_enabled: boolean
          last_run_at: string | null
          name: string
          status: Database["public"]["Enums"]["ai_worker_status"]
          updated_at: string
          worker_key: string
        }
        Insert: {
          agency_id: string
          autonomy?: string
          created_at?: string
          description?: string
          id?: string
          is_enabled?: boolean
          last_run_at?: string | null
          name: string
          status?: Database["public"]["Enums"]["ai_worker_status"]
          updated_at?: string
          worker_key: string
        }
        Update: {
          agency_id?: string
          autonomy?: string
          created_at?: string
          description?: string
          id?: string
          is_enabled?: boolean
          last_run_at?: string | null
          name?: string
          status?: Database["public"]["Enums"]["ai_worker_status"]
          updated_at?: string
          worker_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_workers_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          agency_id: string
          created_at: string
          created_by: string | null
          id: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at: string | null
          revoked: boolean
        }
        Insert: {
          agency_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
        }
        Update: {
          agency_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          agency_id: string
          created_at: string
          created_by: string | null
          end_at: string
          id: string
          lead_id: string | null
          notes: string | null
          start_at: string
          status: string
          timezone: string
          title: string
          updated_at: string
        }
        Insert: {
          agency_id?: string
          created_at?: string
          created_by?: string | null
          end_at: string
          id?: string
          lead_id?: string | null
          notes?: string | null
          start_at: string
          status?: string
          timezone?: string
          title: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          created_by?: string | null
          end_at?: string
          id?: string
          lead_id?: string | null
          notes?: string | null
          start_at?: string
          status?: string
          timezone?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          agency_id: string
          amount_myr: number
          balance_myr: number | null
          created_at: string
          deposit_amount_myr: number | null
          deposit_paid: boolean
          id: string
          lead_id: string | null
          package_id: string | null
          pax: number
          quotation_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          amount_myr?: number
          balance_myr?: number | null
          created_at?: string
          deposit_amount_myr?: number | null
          deposit_paid?: boolean
          id?: string
          lead_id?: string | null
          package_id?: string | null
          pax?: number
          quotation_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          amount_myr?: number
          balance_myr?: number | null
          created_at?: string
          deposit_amount_myr?: number | null
          deposit_paid?: boolean
          id?: string
          lead_id?: string | null
          package_id?: string | null
          pax?: number
          quotation_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          agency_id: string
          ai_enabled: boolean
          ai_muted_at: string | null
          ai_reply_claimed_at: string | null
          ai_reply_due_at: string | null
          channel: Database["public"]["Enums"]["channel"]
          conversation_state: string | null
          created_at: string
          escalated_at: string | null
          escalation_reason: string | null
          external_id: string | null
          first_response_ms: number | null
          human_attention_required: boolean
          id: string
          intelligence: Json
          last_message_at: string
          lead_id: string | null
          state_updated_at: string | null
          status: string
        }
        Insert: {
          agency_id: string
          ai_enabled?: boolean
          ai_muted_at?: string | null
          ai_reply_claimed_at?: string | null
          ai_reply_due_at?: string | null
          channel?: Database["public"]["Enums"]["channel"]
          conversation_state?: string | null
          created_at?: string
          escalated_at?: string | null
          escalation_reason?: string | null
          external_id?: string | null
          first_response_ms?: number | null
          human_attention_required?: boolean
          id?: string
          intelligence?: Json
          last_message_at?: string
          lead_id?: string | null
          state_updated_at?: string | null
          status?: string
        }
        Update: {
          agency_id?: string
          ai_enabled?: boolean
          ai_muted_at?: string | null
          ai_reply_claimed_at?: string | null
          ai_reply_due_at?: string | null
          channel?: Database["public"]["Enums"]["channel"]
          conversation_state?: string | null
          created_at?: string
          escalated_at?: string | null
          escalation_reason?: string | null
          external_id?: string | null
          first_response_ms?: number | null
          human_attention_required?: boolean
          id?: string
          intelligence?: Json
          last_message_at?: string
          lead_id?: string | null
          state_updated_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      conversion_events: {
        Row: {
          actor: string
          agency_id: string
          booking_id: string | null
          created_at: string
          id: string
          lead_id: string | null
          meta: Json
          quotation_id: string | null
          reason: string | null
          stage: string
        }
        Insert: {
          actor?: string
          agency_id: string
          booking_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          meta?: Json
          quotation_id?: string | null
          reason?: string | null
          stage: string
        }
        Update: {
          actor?: string
          agency_id?: string
          booking_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          meta?: Json
          quotation_id?: string | null
          reason?: string | null
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversion_events_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversion_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversion_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversion_events_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_requests: {
        Row: {
          agency_name: string | null
          agency_size: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          intent: string
          monthly_enquiries: string | null
          snapshot: Json
          source: string
          updated_at: string
          whatsapp: string | null
        }
        Insert: {
          agency_name?: string | null
          agency_size?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          intent: string
          monthly_enquiries?: string | null
          snapshot?: Json
          source?: string
          updated_at?: string
          whatsapp?: string | null
        }
        Update: {
          agency_name?: string | null
          agency_size?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          intent?: string
          monthly_enquiries?: string | null
          snapshot?: Json
          source?: string
          updated_at?: string
          whatsapp?: string | null
        }
        Relationships: []
      }
      developer_access: {
        Row: {
          active: boolean
          created_at: string
          granted_by: string | null
          label: string | null
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          granted_by?: string | null
          label?: string | null
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          granted_by?: string | null
          label?: string | null
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      executive_cycles: {
        Row: {
          actions_attempted: number
          actions_awaiting_approval: number
          actions_executed: number
          actions_failed: number
          actions_rejected: number
          agency_id: string
          autonomy_mode: string
          correlation_id: string | null
          created_at: string
          decisions: Json
          error: string | null
          finished_at: string | null
          id: string
          limit_reached: boolean
          opportunities_considered: number
          outcome: string | null
          skipped_reason: string | null
          started_at: string
          status: string
          trigger_type: string
        }
        Insert: {
          actions_attempted?: number
          actions_awaiting_approval?: number
          actions_executed?: number
          actions_failed?: number
          actions_rejected?: number
          agency_id: string
          autonomy_mode: string
          correlation_id?: string | null
          created_at?: string
          decisions?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          limit_reached?: boolean
          opportunities_considered?: number
          outcome?: string | null
          skipped_reason?: string | null
          started_at?: string
          status: string
          trigger_type: string
        }
        Update: {
          actions_attempted?: number
          actions_awaiting_approval?: number
          actions_executed?: number
          actions_failed?: number
          actions_rejected?: number
          agency_id?: string
          autonomy_mode?: string
          correlation_id?: string | null
          created_at?: string
          decisions?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          limit_reached?: boolean
          opportunities_considered?: number
          outcome?: string | null
          skipped_reason?: string | null
          started_at?: string
          status?: string
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "executive_cycles_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      executive_objectives: {
        Row: {
          agency_id: string
          created_at: string
          created_by: string | null
          deadline: string | null
          id: string
          objective_text: string
          parsed_metric: string | null
          status: string
          target_quantity: number | null
          target_segment: string | null
          updated_at: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          created_by?: string | null
          deadline?: string | null
          id?: string
          objective_text: string
          parsed_metric?: string | null
          status?: string
          target_quantity?: number | null
          target_segment?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          created_by?: string | null
          deadline?: string | null
          id?: string
          objective_text?: string
          parsed_metric?: string | null
          status?: string
          target_quantity?: number | null
          target_segment?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "executive_objectives_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      followup_jobs: {
        Row: {
          agency_id: string
          attempts: number
          body: string | null
          channel: Database["public"]["Enums"]["channel"]
          claimed_at: string | null
          context: Json
          conversation_id: string | null
          created_at: string
          dispatched_at: string | null
          id: string
          last_error: string | null
          lead_id: string | null
          quotation_id: string | null
          run_at: string
          skip_reason: string | null
          status: Database["public"]["Enums"]["followup_status"]
          title: string
        }
        Insert: {
          agency_id: string
          attempts?: number
          body?: string | null
          channel?: Database["public"]["Enums"]["channel"]
          claimed_at?: string | null
          context?: Json
          conversation_id?: string | null
          created_at?: string
          dispatched_at?: string | null
          id?: string
          last_error?: string | null
          lead_id?: string | null
          quotation_id?: string | null
          run_at?: string
          skip_reason?: string | null
          status?: Database["public"]["Enums"]["followup_status"]
          title?: string
        }
        Update: {
          agency_id?: string
          attempts?: number
          body?: string | null
          channel?: Database["public"]["Enums"]["channel"]
          claimed_at?: string | null
          context?: Json
          conversation_id?: string | null
          created_at?: string
          dispatched_at?: string | null
          id?: string
          last_error?: string | null
          lead_id?: string | null
          quotation_id?: string | null
          run_at?: string
          skip_reason?: string | null
          status?: Database["public"]["Enums"]["followup_status"]
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "followup_jobs_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followup_jobs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followup_jobs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followup_jobs_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
        ]
      }
      islamic_policies: {
        Row: {
          agency_id: string | null
          authority: string
          code: string
          created_at: string
          effective_from: string
          effective_until: string | null
          id: string
          is_active: boolean
          match_patterns: string[]
          principle: string
          requires_human_review: boolean
          rule_text: string
          scope: string
          severity: string
          source: string
          updated_at: string
          version: number
        }
        Insert: {
          agency_id?: string | null
          authority: string
          code: string
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          is_active?: boolean
          match_patterns?: string[]
          principle: string
          requires_human_review?: boolean
          rule_text: string
          scope: string
          severity: string
          source: string
          updated_at?: string
          version?: number
        }
        Update: {
          agency_id?: string | null
          authority?: string
          code?: string
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          id?: string
          is_active?: boolean
          match_patterns?: string[]
          principle?: string
          requires_human_review?: boolean
          rule_text?: string
          scope?: string
          severity?: string
          source?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "islamic_policies_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      islamic_reviews: {
        Row: {
          agency_id: string
          ai_draft_answer: string | null
          ai_sources: string | null
          amendment_notes: string | null
          approved_answer: string | null
          conversation_id: string | null
          created_at: string
          decided_at: string | null
          dedupe_key: string
          delivered_at: string | null
          delivery_status: string
          escalation_reason: string | null
          holding_sent_at: string | null
          id: string
          lead_id: string | null
          question: string
          reference: string | null
          rejection_reason: string | null
          reviewer_id: string | null
          risk_level: string
          status: string
          topic: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          ai_draft_answer?: string | null
          ai_sources?: string | null
          amendment_notes?: string | null
          approved_answer?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          dedupe_key: string
          delivered_at?: string | null
          delivery_status?: string
          escalation_reason?: string | null
          holding_sent_at?: string | null
          id?: string
          lead_id?: string | null
          question: string
          reference?: string | null
          rejection_reason?: string | null
          reviewer_id?: string | null
          risk_level?: string
          status?: string
          topic?: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          ai_draft_answer?: string | null
          ai_sources?: string | null
          amendment_notes?: string | null
          approved_answer?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          dedupe_key?: string
          delivered_at?: string | null
          delivery_status?: string
          escalation_reason?: string | null
          holding_sent_at?: string | null
          id?: string
          lead_id?: string | null
          question?: string
          reference?: string | null
          rejection_reason?: string | null
          reviewer_id?: string | null
          risk_level?: string
          status?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "islamic_reviews_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "islamic_reviews_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "islamic_reviews_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_articles: {
        Row: {
          agency_id: string
          authority: string | null
          category: Database["public"]["Enums"]["kb_category"]
          content: string
          created_at: string
          created_by: string | null
          file_name: string | null
          file_path: string | null
          id: string
          is_active: boolean
          reviewed_at: string | null
          reviewed_by: string | null
          source: string | null
          summary: string | null
          tags: string[]
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          agency_id: string
          authority?: string | null
          category?: Database["public"]["Enums"]["kb_category"]
          content?: string
          created_at?: string
          created_by?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_active?: boolean
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string | null
          summary?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          version?: number
        }
        Update: {
          agency_id?: string
          authority?: string | null
          category?: Database["public"]["Enums"]["kb_category"]
          content?: string
          created_at?: string
          created_by?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_active?: boolean
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string | null
          summary?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_articles_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_notes: {
        Row: {
          agency_id: string
          author_id: string | null
          body: string
          created_at: string
          id: string
          lead_id: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          lead_id: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          lead_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_notes_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          agency_id: string
          assigned_to: string | null
          budget_basis: string | null
          budget_myr: number | null
          city: string | null
          conversational_style: string | null
          created_at: string
          detected_language: string | null
          do_not_contact: boolean
          do_not_contact_at: string | null
          do_not_contact_reason: string | null
          email: string | null
          full_name: string
          id: string
          language_confidence: number | null
          last_contact_at: string | null
          package_interest: string | null
          pax: number
          phone: string | null
          preferred_language: string
          preferred_month: string | null
          score: number
          source: string
          stage: Database["public"]["Enums"]["lead_stage"]
          tags: string[]
          temperature: Database["public"]["Enums"]["lead_temperature"]
          total_budget_myr: number | null
          traveller_needs: string[]
          updated_at: string
        }
        Insert: {
          agency_id: string
          assigned_to?: string | null
          budget_basis?: string | null
          budget_myr?: number | null
          city?: string | null
          conversational_style?: string | null
          created_at?: string
          detected_language?: string | null
          do_not_contact?: boolean
          do_not_contact_at?: string | null
          do_not_contact_reason?: string | null
          email?: string | null
          full_name: string
          id?: string
          language_confidence?: number | null
          last_contact_at?: string | null
          package_interest?: string | null
          pax?: number
          phone?: string | null
          preferred_language?: string
          preferred_month?: string | null
          score?: number
          source?: string
          stage?: Database["public"]["Enums"]["lead_stage"]
          tags?: string[]
          temperature?: Database["public"]["Enums"]["lead_temperature"]
          total_budget_myr?: number | null
          traveller_needs?: string[]
          updated_at?: string
        }
        Update: {
          agency_id?: string
          assigned_to?: string | null
          budget_basis?: string | null
          budget_myr?: number | null
          city?: string | null
          conversational_style?: string | null
          created_at?: string
          detected_language?: string | null
          do_not_contact?: boolean
          do_not_contact_at?: string | null
          do_not_contact_reason?: string | null
          email?: string | null
          full_name?: string
          id?: string
          language_confidence?: number | null
          last_contact_at?: string | null
          package_interest?: string | null
          pax?: number
          phone?: string | null
          preferred_language?: string
          preferred_month?: string | null
          score?: number
          source?: string
          stage?: Database["public"]["Enums"]["lead_stage"]
          tags?: string[]
          temperature?: Database["public"]["Enums"]["lead_temperature"]
          total_budget_myr?: number | null
          traveller_needs?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      login_events: {
        Row: {
          agency_id: string | null
          created_at: string
          event_type: string
          id: string
          occurred_at: string
          session_key: string | null
          user_id: string
        }
        Insert: {
          agency_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          occurred_at?: string
          session_key?: string | null
          user_id: string
        }
        Update: {
          agency_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          occurred_at?: string
          session_key?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "login_events_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          agency_id: string
          body: string
          conversation_id: string
          created_at: string
          delivery_status: string
          id: string
          media_id: string | null
          modality: string
          provider_message_id: string | null
          sender: Database["public"]["Enums"]["msg_sender"]
        }
        Insert: {
          agency_id: string
          body?: string
          conversation_id: string
          created_at?: string
          delivery_status?: string
          id?: string
          media_id?: string | null
          modality?: string
          provider_message_id?: string | null
          sender: Database["public"]["Enums"]["msg_sender"]
        }
        Update: {
          agency_id?: string
          body?: string
          conversation_id?: string
          created_at?: string
          delivery_status?: string
          id?: string
          media_id?: string | null
          modality?: string
          provider_message_id?: string | null
          sender?: Database["public"]["Enums"]["msg_sender"]
        }
        Relationships: [
          {
            foreignKeyName: "messages_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          agency_id: string
          body: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          kind: string
          meta: Json
          read_at: string | null
          severity: string
          title: string
        }
        Insert: {
          agency_id: string
          body?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          kind: string
          meta?: Json
          read_at?: string | null
          severity?: string
          title: string
        }
        Update: {
          agency_id?: string
          body?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          kind?: string
          meta?: Json
          read_at?: string | null
          severity?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_test_override_events: {
        Row: {
          action: string
          actor_id: string | null
          agency_id: string
          categories: string[]
          created_at: string
          expires_at: string | null
          id: string
          reason: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          agency_id: string
          categories?: string[]
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          agency_id?: string
          categories?: string[]
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_test_override_events_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_test_overrides: {
        Row: {
          agency_id: string
          categories: string[]
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          expires_at: string | null
          reason: string | null
          updated_at: string
        }
        Insert: {
          agency_id: string
          categories?: string[]
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          expires_at?: string | null
          reason?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string
          categories?: string[]
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          expires_at?: string | null
          reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_test_overrides_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: true
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          agency_id: string
          airline: string | null
          created_at: string
          departure_date: string | null
          halal_review_status: string
          halal_reviewed_at: string | null
          halal_reviewed_by: string | null
          hotel_madinah: string | null
          hotel_makkah: string | null
          id: string
          inclusions: string[]
          is_active: boolean
          islamic_review_required: boolean
          name: string
          nights: number
          price_myr: number
          star_rating: number
          updated_at: string
        }
        Insert: {
          agency_id: string
          airline?: string | null
          created_at?: string
          departure_date?: string | null
          halal_review_status?: string
          halal_reviewed_at?: string | null
          halal_reviewed_by?: string | null
          hotel_madinah?: string | null
          hotel_makkah?: string | null
          id?: string
          inclusions?: string[]
          is_active?: boolean
          islamic_review_required?: boolean
          name: string
          nights?: number
          price_myr?: number
          star_rating?: number
          updated_at?: string
        }
        Update: {
          agency_id?: string
          airline?: string | null
          created_at?: string
          departure_date?: string | null
          halal_review_status?: string
          halal_reviewed_at?: string | null
          halal_reviewed_by?: string | null
          hotel_madinah?: string | null
          hotel_makkah?: string | null
          id?: string
          inclusions?: string[]
          is_active?: boolean
          islamic_review_required?: boolean
          name?: string
          nights?: number
          price_myr?: number
          star_rating?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "packages_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          agency_id: string | null
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          job_title: string | null
          last_seen_at: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          agency_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id: string
          job_title?: string | null
          last_seen_at?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          job_title?: string | null
          last_seen_at?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      public_demo_hits: {
        Row: {
          created_at: string
          fingerprint: string | null
          id: string
          ip_hash: string
        }
        Insert: {
          created_at?: string
          fingerprint?: string | null
          id?: string
          ip_hash: string
        }
        Update: {
          created_at?: string
          fingerprint?: string | null
          id?: string
          ip_hash?: string
        }
        Relationships: []
      }
      quotations: {
        Row: {
          accepted_at: string | null
          agency_id: string
          balance_amount: number | null
          cancelled_at: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          customer_name: string | null
          customer_phone: string | null
          deposit_amount: number | null
          deposit_rule: string
          discount: number
          id: string
          lead_id: string | null
          notes: string | null
          number_of_pilgrims: number
          package_id: string | null
          package_snapshot: Json
          public_token: string
          quantity: number
          quotation_number: string
          rejected_at: string | null
          sent_at: string | null
          status: string
          subtotal: number
          total: number
          travel_date: string | null
          travel_month: string | null
          unit_price: number
          updated_at: string
          valid_until: string | null
          viewed_at: string | null
        }
        Insert: {
          accepted_at?: string | null
          agency_id: string
          balance_amount?: number | null
          cancelled_at?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_name?: string | null
          customer_phone?: string | null
          deposit_amount?: number | null
          deposit_rule?: string
          discount?: number
          id?: string
          lead_id?: string | null
          notes?: string | null
          number_of_pilgrims?: number
          package_id?: string | null
          package_snapshot?: Json
          public_token?: string
          quantity?: number
          quotation_number: string
          rejected_at?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          total?: number
          travel_date?: string | null
          travel_month?: string | null
          unit_price?: number
          updated_at?: string
          valid_until?: string | null
          viewed_at?: string | null
        }
        Update: {
          accepted_at?: string | null
          agency_id?: string
          balance_amount?: number | null
          cancelled_at?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_name?: string | null
          customer_phone?: string | null
          deposit_amount?: number | null
          deposit_rule?: string
          discount?: number
          id?: string
          lead_id?: string | null
          notes?: string | null
          number_of_pilgrims?: number
          package_id?: string | null
          package_snapshot?: Json
          public_token?: string
          quantity?: number
          quotation_number?: string
          rejected_at?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          total?: number
          travel_date?: string | null
          travel_month?: string | null
          unit_price?: number
          updated_at?: string
          valid_until?: string | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotations_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_events: {
        Row: {
          agency_id: string
          category: string
          correlation_id: string | null
          counts_against: string
          created_at: string
          duration_seconds: number | null
          event_key: string
          id: string
          input_tokens: number | null
          latency_ms: number | null
          meta: Json
          model: string | null
          occurred_at: string
          operation: string | null
          output_tokens: number | null
          provider: string | null
          source: string | null
          success: boolean
          task_type: string | null
          total_tokens: number | null
          worker: string | null
        }
        Insert: {
          agency_id: string
          category: string
          correlation_id?: string | null
          counts_against?: string
          created_at?: string
          duration_seconds?: number | null
          event_key: string
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          meta?: Json
          model?: string | null
          occurred_at?: string
          operation?: string | null
          output_tokens?: number | null
          provider?: string | null
          source?: string | null
          success?: boolean
          task_type?: string | null
          total_tokens?: number | null
          worker?: string | null
        }
        Update: {
          agency_id?: string
          category?: string
          correlation_id?: string | null
          counts_against?: string
          created_at?: string
          duration_seconds?: number | null
          event_key?: string
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          meta?: Json
          model?: string | null
          occurred_at?: string
          operation?: string | null
          output_tokens?: number | null
          provider?: string | null
          source?: string | null
          success?: boolean
          task_type?: string | null
          total_tokens?: number | null
          worker?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          agency_id: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          agency_id?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          agency_id?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_call_sessions: {
        Row: {
          agency_id: string
          answer_deadline_at: string | null
          answer_requested_at: string | null
          answered_at: string | null
          call_id: string
          callback_nonces: string[]
          caller_phone: string
          created_at: string
          detected_language: string | null
          direction: string
          ended_at: string | null
          gateway_session_id: string | null
          id: string
          media_negotiated_at: string | null
          media_ready_at: string | null
          meta_accepted_at: string | null
          phone_number_id: string
          received_at: string
          status: string
          termination_reason: string | null
          transcript: Json
          turn_count: number
          updated_at: string
          voice_intents: Json
          voice_outcome: string | null
          voice_traveller_count: number | null
        }
        Insert: {
          agency_id: string
          answer_deadline_at?: string | null
          answer_requested_at?: string | null
          answered_at?: string | null
          call_id: string
          callback_nonces?: string[]
          caller_phone: string
          created_at?: string
          detected_language?: string | null
          direction?: string
          ended_at?: string | null
          gateway_session_id?: string | null
          id?: string
          media_negotiated_at?: string | null
          media_ready_at?: string | null
          meta_accepted_at?: string | null
          phone_number_id: string
          received_at?: string
          status?: string
          termination_reason?: string | null
          transcript?: Json
          turn_count?: number
          updated_at?: string
          voice_intents?: Json
          voice_outcome?: string | null
          voice_traveller_count?: number | null
        }
        Update: {
          agency_id?: string
          answer_deadline_at?: string | null
          answer_requested_at?: string | null
          answered_at?: string | null
          call_id?: string
          callback_nonces?: string[]
          caller_phone?: string
          created_at?: string
          detected_language?: string | null
          direction?: string
          ended_at?: string | null
          gateway_session_id?: string | null
          id?: string
          media_negotiated_at?: string | null
          media_ready_at?: string | null
          meta_accepted_at?: string | null
          phone_number_id?: string
          received_at?: string
          status?: string
          termination_reason?: string | null
          transcript?: Json
          turn_count?: number
          updated_at?: string
          voice_intents?: Json
          voice_outcome?: string | null
          voice_traveller_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_call_sessions_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_configs: {
        Row: {
          access_token: string | null
          agency_id: string
          auto_reply: boolean
          business_account_id: string | null
          created_at: string
          display_phone_number: string | null
          has_access_token: boolean | null
          id: string
          is_connected: boolean
          last_inbound_at: string | null
          phone_number_id: string | null
          updated_at: string
          verify_token: string
        }
        Insert: {
          access_token?: string | null
          agency_id: string
          auto_reply?: boolean
          business_account_id?: string | null
          created_at?: string
          display_phone_number?: string | null
          has_access_token?: boolean | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          phone_number_id?: string | null
          updated_at?: string
          verify_token?: string
        }
        Update: {
          access_token?: string | null
          agency_id?: string
          auto_reply?: boolean
          business_account_id?: string | null
          created_at?: string
          display_phone_number?: string | null
          has_access_token?: boolean | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          phone_number_id?: string | null
          updated_at?: string
          verify_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_configs_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: true
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_agency_invitation: {
        Args: { p_token_hash: string }
        Returns: Json
      }
      claim_followup_job: {
        Args: { p_agency_id: string; p_job_id: string; p_stale_after?: string }
        Returns: boolean
      }
      create_agency_invitation: {
        Args: {
          p_email: string
          p_expires_at: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_token_hash: string
        }
        Returns: string
      }
      remove_agency_member: { Args: { p_user_id: string }; Returns: boolean }
      revoke_agency_invitation: { Args: { p_id: string }; Returns: boolean }
      set_agency_member_role: {
        Args: {
          p_role: Database["public"]["Enums"]["app_role"]
          p_user_id: string
        }
        Returns: boolean
      }
      touch_presence: { Args: never; Returns: string }
      verify_cron_secret: { Args: { token: string }; Returns: boolean }
    }
    Enums: {
      ai_task_status:
        | "queued"
        | "processing"
        | "waiting_approval"
        | "completed"
        | "failed"
        | "rejected"
      ai_worker_status:
        | "active"
        | "idle"
        | "processing"
        | "completed"
        | "waiting_approval"
      app_role:
        | "owner"
        | "admin"
        | "agent"
        | "islamic_approver"
        | "platform_owner"
      channel: "whatsapp" | "web" | "manual"
      followup_status: "pending" | "sent" | "skipped" | "failed" | "processing"
      kb_category:
        | "faq"
        | "travel_guide"
        | "package_info"
        | "visa_info"
        | "hotel_info"
        | "general"
        | "islamic_guidance"
      lead_stage:
        | "new"
        | "contacted"
        | "qualified"
        | "proposal"
        | "negotiation"
        | "booked"
        | "completed"
        | "lost"
      lead_temperature: "hot" | "warm" | "cold"
      msg_sender: "customer" | "ai" | "human"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      ai_task_status: [
        "queued",
        "processing",
        "waiting_approval",
        "completed",
        "failed",
        "rejected",
      ],
      ai_worker_status: [
        "active",
        "idle",
        "processing",
        "completed",
        "waiting_approval",
      ],
      app_role: [
        "owner",
        "admin",
        "agent",
        "islamic_approver",
        "platform_owner",
      ],
      channel: ["whatsapp", "web", "manual"],
      followup_status: ["pending", "sent", "skipped", "failed", "processing"],
      kb_category: [
        "faq",
        "travel_guide",
        "package_info",
        "visa_info",
        "hotel_info",
        "general",
        "islamic_guidance",
      ],
      lead_stage: [
        "new",
        "contacted",
        "qualified",
        "proposal",
        "negotiation",
        "booked",
        "completed",
        "lost",
      ],
      lead_temperature: ["hot", "warm", "cold"],
      msg_sender: ["customer", "ai", "human"],
    },
  },
} as const
