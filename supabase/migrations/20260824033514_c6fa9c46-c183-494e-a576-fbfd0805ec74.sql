ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent';
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_delivery_status_check CHECK (delivery_status IN ('sent','send_failed','not_applicable'));