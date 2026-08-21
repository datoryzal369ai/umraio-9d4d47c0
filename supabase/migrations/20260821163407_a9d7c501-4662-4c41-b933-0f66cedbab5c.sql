CREATE OR REPLACE FUNCTION public.verify_cron_secret(token text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  stored text;
BEGIN
  IF token IS NULL OR length(token) = 0 THEN
    RETURN false;
  END IF;
  SELECT decrypted_secret INTO stored
  FROM vault.decrypted_secrets
  WHERE name = 'umraio_cron_secret'
  LIMIT 1;
  IF stored IS NULL THEN
    RETURN false;
  END IF;
  -- digest comparison: equal-length constant-shape compare, no early exit on plaintext
  RETURN extensions.digest(token, 'sha256') = extensions.digest(stored, 'sha256');
END;
$$;

REVOKE ALL ON FUNCTION public.verify_cron_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_cron_secret(text) TO service_role;