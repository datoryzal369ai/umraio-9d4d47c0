-- 1) touch_presence: no longer needs elevated rights (profiles has a self-update policy)
CREATE OR REPLACE FUNCTION public.touch_presence()
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_last timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT last_seen_at INTO v_last FROM public.profiles WHERE id = v_uid;

  IF v_last IS NOT NULL AND v_last > now() - interval '55 seconds' THEN
    RETURN v_last;
  END IF;

  UPDATE public.profiles SET last_seen_at = now() WHERE id = v_uid
  RETURNING last_seen_at INTO v_last;

  RETURN v_last;
END;
$function$;

-- 2) whatsapp_configs: members read non-secret columns; only owners/admins write
DROP POLICY IF EXISTS "agency members manage whatsapp config" ON public.whatsapp_configs;

CREATE POLICY "agency members view whatsapp config"
ON public.whatsapp_configs FOR SELECT TO authenticated
USING (agency_id = private.current_agency_id());

CREATE POLICY "agency admins insert whatsapp config"
ON public.whatsapp_configs FOR INSERT TO authenticated
WITH CHECK (
  agency_id = private.current_agency_id()
  AND (private.has_role(auth.uid(), 'owner') OR private.has_role(auth.uid(), 'admin'))
);

CREATE POLICY "agency admins update whatsapp config"
ON public.whatsapp_configs FOR UPDATE TO authenticated
USING (
  agency_id = private.current_agency_id()
  AND (private.has_role(auth.uid(), 'owner') OR private.has_role(auth.uid(), 'admin'))
)
WITH CHECK (
  agency_id = private.current_agency_id()
  AND (private.has_role(auth.uid(), 'owner') OR private.has_role(auth.uid(), 'admin'))
);

CREATE POLICY "agency admins delete whatsapp config"
ON public.whatsapp_configs FOR DELETE TO authenticated
USING (
  agency_id = private.current_agency_id()
  AND (private.has_role(auth.uid(), 'owner') OR private.has_role(auth.uid(), 'admin'))
);

REVOKE ALL ON public.whatsapp_configs FROM anon;

-- 3) islamic_reviews: creation is a backend-only path; no anon access at all
REVOKE ALL ON public.islamic_reviews FROM anon;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.islamic_reviews FROM authenticated;
GRANT SELECT, UPDATE ON public.islamic_reviews TO authenticated;
GRANT ALL ON public.islamic_reviews TO service_role;

-- 4) quotations: public-token viewing runs server-side only; anon has no table access
REVOKE ALL ON public.quotations FROM anon;
GRANT ALL ON public.quotations TO service_role;