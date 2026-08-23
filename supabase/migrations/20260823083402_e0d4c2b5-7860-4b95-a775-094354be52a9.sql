CREATE OR REPLACE FUNCTION private.can_decide_islamic_review(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.role::text IN ('owner','admin','islamic_approver')
  );
$$;

REVOKE ALL ON FUNCTION private.can_decide_islamic_review(uuid) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "islamic approvers update islamic reviews" ON public.islamic_reviews;
CREATE POLICY "islamic approvers update islamic reviews"
  ON public.islamic_reviews FOR UPDATE TO authenticated
  USING (
    agency_id = private.current_agency_id()
    AND private.can_decide_islamic_review(auth.uid())
  )
  WITH CHECK (agency_id = private.current_agency_id());

DROP FUNCTION IF EXISTS public.can_decide_islamic_review(uuid);