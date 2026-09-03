ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS lead_id uuid,
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS closing_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS disclosure_spoken boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_latency jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS call_summary text;