-- Y-6B: user identity & presence foundation

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'platform_owner';

-- Platform-owner authorization helper (text compare so the freshly added enum
-- label is safe to reference in the same migration).
CREATE OR REPLACE FUNCTION private.is_platform_owner(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.role::text = 'platform_owner'
  );
$$;

REVOKE ALL ON FUNCTION private.is_platform_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_platform_owner(uuid) TO authenticated, service_role;

-- 1. LOGIN EVENTS -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agency_id uuid REFERENCES public.agencies(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  session_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_events_type_check CHECK (event_type IN ('login','logout','refresh'))
);

CREATE INDEX IF NOT EXISTS login_events_agency_idx ON public.login_events (agency_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS login_events_user_idx ON public.login_events (user_id, occurred_at DESC);

-- One login (and one logout) per session: duplicate protection at the database.
CREATE UNIQUE INDEX IF NOT EXISTS login_events_session_unique
  ON public.login_events (user_id, session_key, event_type)
  WHERE session_key IS NOT NULL AND event_type IN ('login','logout');

-- Reads only; all writes are server-controlled (service role).
GRANT SELECT ON public.login_events TO authenticated;
GRANT ALL ON public.login_events TO service_role;

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency members read own agency login events"
  ON public.login_events FOR SELECT TO authenticated
  USING (agency_id IS NOT NULL AND agency_id = private.current_agency_id());

CREATE POLICY "users read their own login events"
  ON public.login_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "platform owner reads all login events"
  ON public.login_events FOR SELECT TO authenticated
  USING (private.is_platform_owner(auth.uid()));

-- 2. PRESENCE ---------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS profiles_last_seen_idx ON public.profiles (agency_id, last_seen_at DESC);

-- Self-only, throttled presence heartbeat. Never accepts a user id or agency id.
CREATE OR REPLACE FUNCTION public.touch_presence()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_last timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT last_seen_at INTO v_last FROM public.profiles WHERE id = v_uid;

  IF v_last IS NOT NULL AND v_last > now() - interval '55 seconds' THEN
    RETURN v_last; -- throttled: no write
  END IF;

  UPDATE public.profiles SET last_seen_at = now() WHERE id = v_uid
  RETURNING last_seen_at INTO v_last;

  RETURN v_last;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_presence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence() TO authenticated, service_role;

-- 3. ACTIVITY ATTRIBUTION ---------------------------------------------------
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS activity_log_actor_user_idx ON public.activity_log (actor_user_id, created_at DESC);

-- 4. PLATFORM OWNER CROSS-AGENCY READ ---------------------------------------
CREATE POLICY "platform owner reads all agencies"
  ON public.agencies FOR SELECT TO authenticated
  USING (private.is_platform_owner(auth.uid()));

CREATE POLICY "platform owner reads all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (private.is_platform_owner(auth.uid()));

CREATE POLICY "platform owner reads all user roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (private.is_platform_owner(auth.uid()));

CREATE POLICY "platform owner reads all activity log"
  ON public.activity_log FOR SELECT TO authenticated
  USING (private.is_platform_owner(auth.uid()));