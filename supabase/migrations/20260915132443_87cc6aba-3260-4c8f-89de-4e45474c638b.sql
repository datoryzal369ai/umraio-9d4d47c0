CREATE TABLE public.payments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  quotation_id uuid NOT NULL REFERENCES public.quotations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('deposit','full')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','expired','cancelled')),
  provider text NOT NULL DEFAULT 'stripe',
  currency text NOT NULL DEFAULT 'MYR',
  amount_myr numeric NOT NULL CHECK (amount_myr > 0),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  checkout_session_id text,
  payment_intent_id text,
  checkout_url text,
  failure_reason text,
  paid_at timestamp with time zone,
  failed_at timestamp with time zone,
  expired_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members read payments"
  ON public.payments FOR SELECT TO authenticated
  USING (agency_id = private.current_agency_id());

CREATE UNIQUE INDEX payments_checkout_session_key
  ON public.payments (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX payments_one_pending_per_booking_kind
  ON public.payments (booking_id, kind) WHERE status = 'pending';
CREATE INDEX payments_agency_created_idx ON public.payments (agency_id, created_at DESC);
CREATE INDEX payments_quotation_idx ON public.payments (quotation_id);
CREATE INDEX payments_payment_intent_idx ON public.payments (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

CREATE TRIGGER payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.payment_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider text NOT NULL DEFAULT 'stripe',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  agency_id uuid REFERENCES public.agencies(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  outcome text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payment_events TO authenticated;
GRANT ALL ON public.payment_events TO service_role;

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members read payment events"
  ON public.payment_events FOR SELECT TO authenticated
  USING (agency_id IS NOT NULL AND agency_id = private.current_agency_id());

CREATE UNIQUE INDEX payment_events_provider_event_key
  ON public.payment_events (provider, provider_event_id);