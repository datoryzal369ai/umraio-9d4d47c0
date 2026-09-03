ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS renagi_signals jsonb NOT NULL DEFAULT '{}'::jsonb;