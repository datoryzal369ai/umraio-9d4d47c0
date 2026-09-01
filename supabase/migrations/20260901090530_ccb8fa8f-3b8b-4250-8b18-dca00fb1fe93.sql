CREATE TABLE public.appointments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agency_id uuid NOT NULL DEFAULT private.current_agency_id() REFERENCES public.agencies(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  title text NOT NULL,
  notes text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  status text NOT NULL DEFAULT 'scheduled',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_status_check CHECK (status IN ('scheduled','cancelled','completed')),
  CONSTRAINT appointments_time_range_check CHECK (end_at > start_at)
);

CREATE INDEX appointments_agency_start_idx ON public.appointments (agency_id, start_at);
CREATE INDEX appointments_lead_idx ON public.appointments (agency_id, lead_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments TO authenticated;
GRANT ALL ON public.appointments TO service_role;

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members manage appointments"
ON public.appointments
FOR ALL
TO authenticated
USING (agency_id = private.current_agency_id())
WITH CHECK (agency_id = private.current_agency_id());

CREATE TRIGGER appointments_updated_at
BEFORE UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();