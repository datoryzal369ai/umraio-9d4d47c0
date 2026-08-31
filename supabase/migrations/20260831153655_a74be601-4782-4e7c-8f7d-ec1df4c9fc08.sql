CREATE TABLE public.agency_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  email text NOT NULL,
  role app_role NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_invitations_role_allowed CHECK (role IN ('admin','agent','islamic_approver')),
  CONSTRAINT agency_invitations_status_allowed CHECK (status IN ('pending','accepted','revoked'))
);

CREATE INDEX agency_invitations_agency_idx ON public.agency_invitations (agency_id, created_at DESC);
CREATE UNIQUE INDEX agency_invitations_pending_email_idx
  ON public.agency_invitations (agency_id, lower(email)) WHERE status = 'pending';

GRANT SELECT ON public.agency_invitations TO authenticated;
GRANT ALL ON public.agency_invitations TO service_role;

ALTER TABLE public.agency_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members view invitations"
  ON public.agency_invitations FOR SELECT TO authenticated
  USING (agency_id = private.current_agency_id());

CREATE TRIGGER agency_invitations_updated_at
  BEFORE UPDATE ON public.agency_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tenant immutability stays enforced; bypass only inside the audited functions below.
CREATE OR REPLACE FUNCTION public.prevent_profile_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id cannot be modified';
  END IF;
  IF NEW.agency_id IS DISTINCT FROM OLD.agency_id
     AND COALESCE(current_setting('umraio.allow_tenant_move', true), '') <> 'on' THEN
    RAISE EXCEPTION 'agency_id cannot be modified';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.is_agency_manager(_user_id uuid, _agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.agency_id = _agency_id
      AND ur.role::text IN ('owner','admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.create_agency_invitation(
  p_email text,
  p_role app_role,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_agency uuid;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_role::text NOT IN ('admin','agent','islamic_approver') THEN
    RAISE EXCEPTION 'role not invitable';
  END IF;
  IF p_email IS NULL OR position('@' in p_email) < 2 THEN
    RAISE EXCEPTION 'invalid email';
  END IF;
  IF p_token_hash IS NULL OR length(p_token_hash) < 32 THEN
    RAISE EXCEPTION 'invalid token';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'invalid expiry';
  END IF;

  SELECT agency_id INTO v_agency FROM public.profiles WHERE id = v_uid;
  IF v_agency IS NULL THEN RAISE EXCEPTION 'no agency'; END IF;
  IF NOT private.is_agency_manager(v_uid, v_agency) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.agency_invitations
     SET status = 'revoked'
   WHERE agency_id = v_agency AND lower(email) = lower(p_email) AND status = 'pending';

  INSERT INTO public.agency_invitations (agency_id, email, role, token_hash, expires_at, invited_by)
  VALUES (v_agency, lower(p_email), p_role, p_token_hash, p_expires_at, v_uid)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_agency_invitation(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_agency uuid;
  v_done uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT agency_id INTO v_agency FROM public.profiles WHERE id = v_uid;
  IF v_agency IS NULL OR NOT private.is_agency_manager(v_uid, v_agency) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.agency_invitations
     SET status = 'revoked'
   WHERE id = p_id AND agency_id = v_agency AND status = 'pending'
  RETURNING id INTO v_done;

  RETURN v_done IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_agency_invitation(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_inv public.agency_invitations%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Founder / platform owner accounts are never re-tenanted by an invitation.
  IF private.is_platform_owner(v_uid) THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  SELECT * INTO v_inv FROM public.agency_invitations
   WHERE token_hash = p_token_hash
   FOR UPDATE;

  IF NOT FOUND
     OR v_inv.status <> 'pending'
     OR v_inv.expires_at <= now()
     OR lower(v_inv.email) <> v_email
     OR v_inv.role::text NOT IN ('admin','agent','islamic_approver') THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  UPDATE public.agency_invitations
     SET status = 'accepted', accepted_by = v_uid, accepted_at = now()
   WHERE id = v_inv.id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  PERFORM set_config('umraio.allow_tenant_move', 'on', true);
  DELETE FROM public.user_roles WHERE user_id = v_uid;
  UPDATE public.profiles SET agency_id = v_inv.agency_id WHERE id = v_uid;
  INSERT INTO public.user_roles (user_id, agency_id, role)
  VALUES (v_uid, v_inv.agency_id, v_inv.role)
  ON CONFLICT (user_id, role) DO UPDATE SET agency_id = EXCLUDED.agency_id;
  PERFORM set_config('umraio.allow_tenant_move', 'off', true);

  RETURN jsonb_build_object('ok', true, 'agency_id', v_inv.agency_id, 'role', v_inv.role);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_agency_member_role(p_user_id uuid, p_role app_role)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_agency uuid;
  v_target_agency uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_role::text NOT IN ('admin','agent','islamic_approver') THEN
    RAISE EXCEPTION 'role not assignable';
  END IF;
  IF p_user_id = v_uid THEN RAISE EXCEPTION 'cannot change own role'; END IF;

  SELECT agency_id INTO v_agency FROM public.profiles WHERE id = v_uid;
  IF v_agency IS NULL OR NOT private.has_role(v_uid, 'owner') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT agency_id INTO v_target_agency FROM public.profiles WHERE id = p_user_id;
  IF v_target_agency IS DISTINCT FROM v_agency THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF private.has_role(p_user_id, 'owner') OR private.is_platform_owner(p_user_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, agency_id, role) VALUES (p_user_id, v_agency, p_role)
  ON CONFLICT (user_id, role) DO UPDATE SET agency_id = EXCLUDED.agency_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_agency_member(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_agency uuid;
  v_target_agency uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_user_id = v_uid THEN RAISE EXCEPTION 'cannot remove self'; END IF;

  SELECT agency_id INTO v_agency FROM public.profiles WHERE id = v_uid;
  IF v_agency IS NULL OR NOT private.has_role(v_uid, 'owner') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT agency_id INTO v_target_agency FROM public.profiles WHERE id = p_user_id;
  IF v_target_agency IS DISTINCT FROM v_agency THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF private.has_role(p_user_id, 'owner') OR private.is_platform_owner(p_user_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  PERFORM set_config('umraio.allow_tenant_move', 'on', true);
  UPDATE public.profiles SET agency_id = NULL WHERE id = p_user_id;
  PERFORM set_config('umraio.allow_tenant_move', 'off', true);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_agency_invitation(text, app_role, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_agency_invitation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_agency_invitation(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_agency_member_role(uuid, app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_agency_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_agency_invitation(text, app_role, text, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_agency_invitation(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_agency_invitation(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_agency_member_role(uuid, app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_agency_member(uuid) TO authenticated, service_role;