-- 1. SECURITY DEFINER functions: execute only for authenticated, never PUBLIC/anon
REVOKE ALL ON FUNCTION public.accept_agency_invitation(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_agency_invitation(text, app_role, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_agency_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_agency_invitation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_agency_member_role(uuid, app_role) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.accept_agency_invitation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_agency_invitation(text, app_role, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_agency_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agency_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_agency_member_role(uuid, app_role) TO authenticated;

-- 2. islamic_reviews: explicit agency-scoped INSERT policy (writes remain server-side only)
DROP POLICY IF EXISTS "agency members insert islamic reviews" ON public.islamic_reviews;
CREATE POLICY "agency members insert islamic reviews"
ON public.islamic_reviews
FOR INSERT
TO authenticated
WITH CHECK (agency_id = private.current_agency_id());

-- 3. quotations: fail-closed for anon; public links are verified server-side only
REVOKE ALL ON public.quotations FROM anon;
REVOKE TRUNCATE, TRIGGER ON public.quotations FROM authenticated;

-- 4. whatsapp_configs / islamic_reviews: remove residual destructive privileges
REVOKE ALL ON public.whatsapp_configs FROM anon;
REVOKE TRUNCATE, TRIGGER ON public.whatsapp_configs FROM authenticated;
REVOKE ALL ON public.islamic_reviews FROM anon;
REVOKE TRUNCATE, TRIGGER ON public.islamic_reviews FROM authenticated;