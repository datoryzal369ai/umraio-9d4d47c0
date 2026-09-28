-- UMRAIO® 24/7 Autonomous Intelligent Customer Care — email foundation.
-- Email is separate from the proven WhatsApp conversation pipeline so existing
-- quotations, bookings, follow-ups and payment webhooks remain untouched.

CREATE TABLE IF NOT EXISTS public.support_email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  external_thread_id text NOT NULL,
  customer_email text NOT NULL,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','pending_human','closed')),
  ai_enabled boolean NOT NULL DEFAULT true,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, external_thread_id)
);

CREATE TABLE IF NOT EXISTS public.support_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.support_email_threads(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender text NOT NULL CHECK (sender IN ('customer','ai','human','system')),
  body text NOT NULL,
  provider_message_id text,
  delivery_status text NOT NULL
    CHECK (delivery_status IN ('received','draft','pending_approval','sent','send_failed')),
  requires_approval boolean NOT NULL DEFAULT false,
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_code text,
  category text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS support_email_provider_message_uq
  ON public.support_email_messages(agency_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_email_thread_messages_idx
  ON public.support_email_messages(thread_id, created_at DESC);

GRANT SELECT ON public.support_email_threads TO authenticated;
GRANT SELECT ON public.support_email_messages TO authenticated;
GRANT ALL ON public.support_email_threads TO service_role;
GRANT ALL ON public.support_email_messages TO service_role;

ALTER TABLE public.support_email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_email_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agency members can view support email threads"
  ON public.support_email_threads
  FOR SELECT TO authenticated
  USING (agency_id = public.current_agency_id());

CREATE POLICY "Agency members can view support email messages"
  ON public.support_email_messages
  FOR SELECT TO authenticated
  USING (agency_id = public.current_agency_id());

CREATE TRIGGER update_support_email_threads_updated_at
  BEFORE UPDATE ON public.support_email_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
