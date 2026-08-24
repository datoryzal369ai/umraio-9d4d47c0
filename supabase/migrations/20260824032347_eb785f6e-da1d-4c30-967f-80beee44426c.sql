ALTER TYPE public.followup_status ADD VALUE IF NOT EXISTS 'processing';

ALTER TABLE public.followup_jobs
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE OR REPLACE FUNCTION public.claim_followup_job(
  p_job_id uuid,
  p_agency_id uuid,
  p_stale_after interval DEFAULT '10 minutes'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_claimed uuid;
BEGIN
  UPDATE public.followup_jobs
     SET status = 'processing',
         claimed_at = now(),
         attempts = COALESCE(attempts, 0) + 1
   WHERE id = p_job_id
     AND agency_id = p_agency_id
     AND (
       status = 'pending'
       OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < now() - p_stale_after)
     )
  RETURNING id INTO v_claimed;

  RETURN v_claimed IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_followup_job(uuid, uuid, interval) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_followup_job(uuid, uuid, interval) TO service_role;