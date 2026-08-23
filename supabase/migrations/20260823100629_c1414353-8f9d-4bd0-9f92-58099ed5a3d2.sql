CREATE TABLE public.owner_test_overrides (
  agency_id uuid PRIMARY KEY REFERENCES public.agencies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL DEFAULT '{}',
  reason text,
  enabled_by uuid REFERENCES auth.users(id),
  enabled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.owner_test_overrides TO authenticated;
GRANT ALL ON public.owner_test_overrides TO service_role;
ALTER TABLE public.owner_test_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view own agency test override" ON public.owner_test_overrides
  FOR SELECT TO authenticated USING (agency_id = private.current_agency_id());
CREATE POLICY "Owners create own agency test override" ON public.owner_test_overrides
  FOR INSERT TO authenticated
  WITH CHECK (agency_id = private.current_agency_id() AND private.has_role(auth.uid(),'owner'));
CREATE POLICY "Owners update own agency test override" ON public.owner_test_overrides
  FOR UPDATE TO authenticated
  USING (agency_id = private.current_agency_id() AND private.has_role(auth.uid(),'owner'))
  WITH CHECK (agency_id = private.current_agency_id() AND private.has_role(auth.uid(),'owner'));

CREATE TRIGGER owner_test_overrides_updated_at BEFORE UPDATE ON public.owner_test_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.owner_test_override_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  action text NOT NULL CHECK (action IN ('enabled','disabled')),
  categories text[] NOT NULL DEFAULT '{}',
  reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_test_override_events_agency_idx
  ON public.owner_test_override_events (agency_id, created_at DESC);

GRANT SELECT, INSERT ON public.owner_test_override_events TO authenticated;
GRANT ALL ON public.owner_test_override_events TO service_role;
ALTER TABLE public.owner_test_override_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners view own agency override audit" ON public.owner_test_override_events
  FOR SELECT TO authenticated
  USING (agency_id = private.current_agency_id() AND private.has_role(auth.uid(),'owner'));
CREATE POLICY "Owners append own agency override audit" ON public.owner_test_override_events
  FOR INSERT TO authenticated
  WITH CHECK (agency_id = private.current_agency_id() AND private.has_role(auth.uid(),'owner') AND actor_id = auth.uid());