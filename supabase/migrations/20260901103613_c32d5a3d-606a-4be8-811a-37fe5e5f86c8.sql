CREATE TABLE public.whatsapp_call_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  phone_number_id text NOT NULL,
  caller_phone text NOT NULL,
  direction text NOT NULL DEFAULT 'inbound',
  status text NOT NULL DEFAULT 'ringing',
  received_at timestamptz NOT NULL DEFAULT now(),
  answer_deadline_at timestamptz,
  answer_requested_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  termination_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_call_sessions_status_check
    CHECK (status IN ('ringing','answer_requested','answered','missed','terminated','failed')),
  CONSTRAINT whatsapp_call_sessions_direction_check CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT whatsapp_call_sessions_call_id_unique UNIQUE (call_id)
);

CREATE INDEX whatsapp_call_sessions_agency_received_idx
  ON public.whatsapp_call_sessions (agency_id, received_at DESC);

GRANT SELECT ON public.whatsapp_call_sessions TO authenticated;
GRANT ALL ON public.whatsapp_call_sessions TO service_role;
REVOKE ALL ON TABLE public.whatsapp_call_sessions FROM anon;

ALTER TABLE public.whatsapp_call_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members read call sessions"
ON public.whatsapp_call_sessions
FOR SELECT
TO authenticated
USING (agency_id = private.current_agency_id());

CREATE TRIGGER whatsapp_call_sessions_updated_at
BEFORE UPDATE ON public.whatsapp_call_sessions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();