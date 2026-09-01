-- Validation found the earlier column-level revoke was ineffective: the
-- `authenticated` role still held TABLE-level INSERT/UPDATE on
-- whatsapp_configs, which implicitly covers access_token / verify_token.
-- All writes now go through authenticated server functions using the
-- privileged client, so the role needs no write privilege at all.
REVOKE INSERT, UPDATE, DELETE, REFERENCES ON public.whatsapp_configs FROM authenticated;
REVOKE ALL ON public.whatsapp_configs FROM anon;
GRANT ALL ON public.whatsapp_configs TO service_role;