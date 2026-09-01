ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS gateway_session_id text,
  ADD COLUMN IF NOT EXISTS media_negotiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS meta_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS callback_nonces text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.whatsapp_call_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_call_sessions_status_check;

ALTER TABLE public.whatsapp_call_sessions
  ADD CONSTRAINT whatsapp_call_sessions_status_check
  CHECK (status IN ('ringing','answer_requested','media_negotiating','answered','missed','terminated','failed'));