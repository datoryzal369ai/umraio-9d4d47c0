ALTER TABLE public.agency_settings
  ADD COLUMN IF NOT EXISTS voice_language text NOT NULL DEFAULT 'ms-MY';