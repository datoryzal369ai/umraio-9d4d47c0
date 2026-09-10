-- Narrow privilege repair for RAIŌ WhatsApp Calling Cognitive Bridge v1.
-- Preserve governed SECURITY DEFINER RPCs as the only mutation boundary.
BEGIN;

REVOKE ALL ON TABLE
  public.calling_bridge_sessions,
  public.calling_bridge_turns,
  public.calling_caller_turns,
  public.calling_bridge_events,
  public.calling_bridge_actions
FROM service_role;

GRANT SELECT ON TABLE
  public.calling_bridge_sessions,
  public.calling_bridge_turns,
  public.calling_caller_turns,
  public.calling_bridge_events,
  public.calling_bridge_actions
TO service_role;

COMMIT;
