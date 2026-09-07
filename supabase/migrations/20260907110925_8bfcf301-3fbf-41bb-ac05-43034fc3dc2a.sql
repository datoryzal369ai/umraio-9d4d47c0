-- Widening-only compatibility migration (Calling P0). Existing values stay valid.

ALTER TABLE public.whatsapp_call_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_call_sessions_status_check;
ALTER TABLE public.whatsapp_call_sessions
  ADD CONSTRAINT whatsapp_call_sessions_status_check
  CHECK (status = ANY (ARRAY[
    'ringing'::text,
    'answer_requested'::text,
    'media_negotiating'::text,
    'meta_pre_accepted'::text,
    'answered'::text,
    'missed'::text,
    'terminated'::text,
    'failed'::text
  ]));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_modality_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_modality_check
  CHECK (modality = ANY (ARRAY[
    'text'::text,
    'audio'::text,
    'image'::text,
    'call_summary'::text
  ]));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status = ANY (ARRAY[
    'sent'::text,
    'delivered'::text,
    'read'::text,
    'failed'::text,
    'send_failed'::text,
    'not_applicable'::text,
    'internal'::text
  ]));