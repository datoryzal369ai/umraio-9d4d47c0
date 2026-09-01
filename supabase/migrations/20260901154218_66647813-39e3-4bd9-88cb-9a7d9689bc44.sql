ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS turn_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detected_language text,
  ADD COLUMN IF NOT EXISTS voice_intents jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_outcome text,
  ADD COLUMN IF NOT EXISTS voice_traveller_count integer;