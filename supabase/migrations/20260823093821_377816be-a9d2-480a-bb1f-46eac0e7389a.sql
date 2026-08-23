DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (id = auth.uid() AND agency_id IS NULL);

-- Also block setting agency_id from NULL to a value via UPDATE by non-system paths
CREATE OR REPLACE FUNCTION public.prevent_profile_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN
    RAISE EXCEPTION 'agency_id cannot be modified';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id cannot be modified';
  END IF;
  RETURN NEW;
END;
$function$;