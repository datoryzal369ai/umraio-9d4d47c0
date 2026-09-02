CREATE TABLE public.executive_objectives (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  objective_text text NOT NULL,
  parsed_metric text,
  target_quantity numeric,
  deadline date,
  target_segment text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT executive_objectives_status_check CHECK (status IN ('active','completed','closed')),
  CONSTRAINT executive_objectives_text_check CHECK (length(btrim(objective_text)) > 0),
  CONSTRAINT executive_objectives_qty_check CHECK (target_quantity IS NULL OR target_quantity > 0)
);

CREATE INDEX executive_objectives_agency_created_idx
  ON public.executive_objectives (agency_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.executive_objectives TO authenticated;
GRANT ALL ON public.executive_objectives TO service_role;

ALTER TABLE public.executive_objectives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members manage executive objectives"
  ON public.executive_objectives
  FOR ALL
  TO authenticated
  USING (agency_id = private.current_agency_id())
  WITH CHECK (agency_id = private.current_agency_id());

CREATE TRIGGER executive_objectives_updated_at
  BEFORE UPDATE ON public.executive_objectives
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();