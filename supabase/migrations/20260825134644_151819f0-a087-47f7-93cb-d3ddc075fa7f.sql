CREATE TEMP TABLE _lead_dupes AS
WITH ranked AS (
  SELECT id, agency_id, phone,
         first_value(id) OVER (PARTITION BY agency_id, phone ORDER BY created_at, id) AS keep_id
  FROM public.leads
  WHERE phone IS NOT NULL
)
SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id;

UPDATE public.bookings b SET lead_id = d.keep_id FROM _lead_dupes d WHERE b.lead_id = d.dup_id;
UPDATE public.conversations c SET lead_id = d.keep_id FROM _lead_dupes d WHERE c.lead_id = d.dup_id;
UPDATE public.conversion_events e SET lead_id = d.keep_id FROM _lead_dupes d WHERE e.lead_id = d.dup_id;
UPDATE public.followup_jobs f SET lead_id = d.keep_id FROM _lead_dupes d WHERE f.lead_id = d.dup_id;
UPDATE public.islamic_reviews r SET lead_id = d.keep_id FROM _lead_dupes d WHERE r.lead_id = d.dup_id;
UPDATE public.lead_notes n SET lead_id = d.keep_id FROM _lead_dupes d WHERE n.lead_id = d.dup_id;
UPDATE public.ai_tasks t SET lead_id = d.keep_id FROM _lead_dupes d WHERE t.lead_id = d.dup_id;
UPDATE public.quotations q SET lead_id = d.keep_id FROM _lead_dupes d WHERE q.lead_id = d.dup_id;

DELETE FROM public.leads l USING _lead_dupes d WHERE l.id = d.dup_id;

DROP TABLE _lead_dupes;

CREATE UNIQUE INDEX IF NOT EXISTS leads_agency_phone_unique
  ON public.leads (agency_id, phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_agency_external_id_unique
  ON public.conversations (agency_id, external_id)
  WHERE external_id IS NOT NULL;