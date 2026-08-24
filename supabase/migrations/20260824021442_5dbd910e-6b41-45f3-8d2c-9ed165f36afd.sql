-- B-1: restore least-privilege write access to conversion_events
GRANT SELECT, INSERT ON public.conversion_events TO authenticated;
GRANT SELECT, INSERT ON public.conversion_events TO service_role;

ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency members insert conversion events" ON public.conversion_events;
CREATE POLICY "agency members insert conversion events"
  ON public.conversion_events
  FOR INSERT
  TO authenticated
  WITH CHECK (agency_id = private.current_agency_id());