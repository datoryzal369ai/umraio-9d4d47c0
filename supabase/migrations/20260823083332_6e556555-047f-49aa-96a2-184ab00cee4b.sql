-- Islamic Implementation Layer V1: dedicated review domain
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'islamic_approver';

-- Dedicated Islamic approval authorization (separate from sales approvals).
-- Compares on text so the newly added enum label is safe to reference here.
CREATE OR REPLACE FUNCTION public.can_decide_islamic_review(_user_id uuid)
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

REVOKE ALL ON FUNCTION public.can_decide_islamic_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_decide_islamic_review(uuid) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.islamic_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  question text NOT NULL,
  topic text NOT NULL DEFAULT 'other',
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  reviewer_id uuid REFERENCES auth.users(id),
  approved_answer text,
  rejection_reason text,
  amendment_notes text,
  holding_sent_at timestamptz,
  delivered_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'not_started',
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT islamic_reviews_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED','AMENDED')),
  CONSTRAINT islamic_reviews_delivery_status_check CHECK (delivery_status IN ('not_started','sent','failed','not_applicable'))
);

CREATE INDEX IF NOT EXISTS islamic_reviews_agency_idx ON public.islamic_reviews (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS islamic_reviews_conversation_idx ON public.islamic_reviews (conversation_id, status);
CREATE INDEX IF NOT EXISTS islamic_reviews_lead_idx ON public.islamic_reviews (lead_id);
CREATE INDEX IF NOT EXISTS islamic_reviews_status_idx ON public.islamic_reviews (agency_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS islamic_reviews_open_unique
  ON public.islamic_reviews (agency_id, conversation_id, dedupe_key)
  WHERE status IN ('PENDING','AMENDED');

GRANT SELECT, UPDATE ON public.islamic_reviews TO authenticated;
GRANT ALL ON public.islamic_reviews TO service_role;

ALTER TABLE public.islamic_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members view islamic reviews"
  ON public.islamic_reviews FOR SELECT TO authenticated
  USING (agency_id = private.current_agency_id());

CREATE POLICY "islamic approvers update islamic reviews"
  ON public.islamic_reviews FOR UPDATE TO authenticated
  USING (
    agency_id = private.current_agency_id()
    AND public.can_decide_islamic_review(auth.uid())
  )
  WITH CHECK (agency_id = private.current_agency_id());

CREATE TRIGGER islamic_reviews_updated_at
  BEFORE UPDATE ON public.islamic_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();