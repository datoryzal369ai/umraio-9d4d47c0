-- 1) whatsapp_configs credential columns: service-role only.
--    SELECT was already revoked; this removes the remaining write privileges so
--    no agency member can overwrite or exfiltrate-by-replacing the Meta token.
REVOKE INSERT (access_token), UPDATE (access_token), REFERENCES (access_token)
  ON public.whatsapp_configs FROM authenticated;
REVOKE INSERT (verify_token), UPDATE (verify_token), REFERENCES (verify_token)
  ON public.whatsapp_configs FROM authenticated;
REVOKE ALL (access_token) ON public.whatsapp_configs FROM anon;
REVOKE ALL (verify_token) ON public.whatsapp_configs FROM anon;
GRANT ALL ON public.whatsapp_configs TO service_role;

-- 2) SECURITY DEFINER hardening: private.is_agency_manager still had the
--    default PUBLIC execute grant (callable by anon). Match its siblings.
REVOKE ALL ON FUNCTION private.is_agency_manager(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_agency_manager(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION private.is_agency_manager(uuid, uuid) TO authenticated, service_role;