ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS messages_agency_provider_msg_uniq
  ON public.messages (agency_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;