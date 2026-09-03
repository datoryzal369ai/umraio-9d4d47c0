ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS meta_pre_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS stage_timings jsonb NOT NULL DEFAULT '{}'::jsonb;