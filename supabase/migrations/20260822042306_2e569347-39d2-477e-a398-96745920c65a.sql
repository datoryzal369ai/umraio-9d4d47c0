ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_id text;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_modality_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_modality_check CHECK (modality IN ('text','audio'));

CREATE INDEX IF NOT EXISTS messages_agency_modality_idx ON public.messages (agency_id, modality, created_at DESC);

ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS duration_seconds integer;

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_category_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_category_check
  CHECK (category IN ('customer_reply','internal_operation','ai_task','voice_transcription'));

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_counts_against_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_counts_against_check
  CHECK (counts_against IN ('ai_replies','ai_tasks','voice_minutes','none'));