CREATE TABLE public.developer_access (
  user_id uuid PRIMARY KEY,
  label text,
  active boolean NOT NULL DEFAULT true,
  granted_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.developer_access TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.developer_access TO authenticated;
GRANT ALL ON public.developer_access TO service_role;

ALTER TABLE public.developer_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Developers can view own access row"
ON public.developer_access FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Founder can view developer access"
ON public.developer_access FOR SELECT TO authenticated
USING (private.has_role(auth.uid(), 'platform_owner'::public.app_role));

CREATE POLICY "Founder can grant developer access"
ON public.developer_access FOR INSERT TO authenticated
WITH CHECK (private.has_role(auth.uid(), 'platform_owner'::public.app_role));

CREATE POLICY "Founder can update developer access"
ON public.developer_access FOR UPDATE TO authenticated
USING (private.has_role(auth.uid(), 'platform_owner'::public.app_role))
WITH CHECK (private.has_role(auth.uid(), 'platform_owner'::public.app_role));

CREATE POLICY "Founder can revoke developer access"
ON public.developer_access FOR DELETE TO authenticated
USING (private.has_role(auth.uid(), 'platform_owner'::public.app_role));