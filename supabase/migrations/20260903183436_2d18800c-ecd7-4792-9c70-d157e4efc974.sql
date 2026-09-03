-- 1. WhatsApp credential exposure: narrow the read rule to owners/admins only,
--    and make the credential column unreadable at the privilege layer too.
DROP POLICY IF EXISTS "agency members view whatsapp config" ON public.whatsapp_configs;

CREATE POLICY "agency admins view whatsapp config"
ON public.whatsapp_configs
FOR SELECT
TO authenticated
USING (
  agency_id = private.current_agency_id()
  AND (private.has_role(auth.uid(), 'owner'::app_role) OR private.has_role(auth.uid(), 'admin'::app_role))
);

REVOKE ALL ON public.whatsapp_configs FROM anon;
REVOKE ALL ON public.whatsapp_configs FROM authenticated;
REVOKE ALL (access_token) ON public.whatsapp_configs FROM anon, authenticated;
GRANT ALL ON public.whatsapp_configs TO service_role;

-- 2. Islamic reviews: deletion is an immutable-audit violation. Make the denial
--    explicit rather than implicit, and remove any delete privilege.
DROP POLICY IF EXISTS "no one deletes islamic reviews" ON public.islamic_reviews;

CREATE POLICY "no one deletes islamic reviews"
ON public.islamic_reviews
FOR DELETE
TO authenticated
USING (false);

REVOKE DELETE ON public.islamic_reviews FROM anon, authenticated;
GRANT ALL ON public.islamic_reviews TO service_role;