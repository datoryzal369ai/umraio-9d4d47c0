ALTER TABLE public.agency_settings
  ADD COLUMN IF NOT EXISTS voice_persona text NOT NULL DEFAULT 'premium_sales_executive',
  ADD COLUMN IF NOT EXISTS voice_controls jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_name text;