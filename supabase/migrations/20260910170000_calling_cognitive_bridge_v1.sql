-- Additive Calling-only storage. No Voice Note tables, policies or production configuration changes.
BEGIN;
CREATE TABLE public.calling_bridge_sessions (
  session_id uuid PRIMARY KEY REFERENCES public.whatsapp_call_sessions(id),
  agency_id uuid NOT NULL REFERENCES public.agencies(id),
  call_id text NOT NULL,
  gateway_session_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  revision bigint NOT NULL DEFAULT 0,
  current_sequence integer NOT NULL DEFAULT 0,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  closing_state text NOT NULL DEFAULT 'active' CHECK (closing_state IN ('active','possible_completion','farewell_committed','terminal')),
  closing_episode uuid,
  closing_clarifications integer NOT NULL DEFAULT 0 CHECK (closing_clarifications BETWEEN 0 AND 1),
  farewell_id uuid,
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agency_id, session_id)
);
CREATE TABLE public.calling_bridge_turns (
  agency_id uuid NOT NULL,
  session_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('greeting','utterance')),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (agency_id, session_id, sequence),
  FOREIGN KEY (agency_id, session_id) REFERENCES public.calling_bridge_sessions(agency_id, session_id)
);
CREATE TABLE public.calling_caller_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  session_id uuid NOT NULL,
  sequence integer NOT NULL,
  generation uuid NOT NULL,
  transcript text NOT NULL CHECK (length(btrim(transcript)) > 0),
  received_at timestamptz NOT NULL,
  asr_completed_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  language text,
  duration_ms integer CHECK (duration_ms >= 0),
  confidence text NOT NULL DEFAULT 'unknown' CHECK (confidence = 'unknown'),
  channel text NOT NULL DEFAULT 'whatsapp_calling' CHECK (channel = 'whatsapp_calling'),
  UNIQUE (agency_id, session_id, sequence),
  FOREIGN KEY (agency_id, session_id, sequence) REFERENCES public.calling_bridge_turns(agency_id, session_id, sequence)
);
ALTER TABLE public.calling_bridge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calling_bridge_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calling_caller_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calling_bridge_sessions, public.calling_bridge_turns, public.calling_caller_turns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.calling_bridge_sessions, public.calling_bridge_turns, public.calling_caller_turns TO service_role;

CREATE FUNCTION public.calling_bridge_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'calling_append_only' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER calling_caller_turns_immutable BEFORE UPDATE OR DELETE ON public.calling_caller_turns
  FOR EACH ROW EXECUTE FUNCTION public.calling_bridge_immutable();
CREATE TRIGGER calling_bridge_turns_immutable BEFORE UPDATE OR DELETE ON public.calling_bridge_turns
  FOR EACH ROW EXECUTE FUNCTION public.calling_bridge_immutable();

CREATE FUNCTION public.calling_bridge_begin(p_agency uuid, p_session uuid, p_call text, p_gateway text,
  p_sequence integer, p_greeting boolean, p_received_at timestamptz, p_request_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET statement_timeout = '2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; t public.calling_bridge_turns;
  v_turn jsonb; v_live boolean; v_generation uuid := gen_random_uuid();
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency
    AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  v_live := c.meta_accepted_at IS NOT NULL AND c.status IN ('answer_requested','media_negotiating','answered');
  SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session FOR UPDATE;
  IF NOT FOUND THEN
    -- Pin only new calls at their existing greeting. In-flight legacy calls remain legacy.
    IF NOT p_greeting THEN RETURN jsonb_build_object('state','legacy','can_respond',false); END IF;
    IF NOT v_live THEN RETURN jsonb_build_object('state','terminal','can_respond',false); END IF;
    INSERT INTO public.calling_bridge_sessions(session_id,agency_id,call_id,gateway_session_id)
      VALUES(p_session,p_agency,p_call,p_gateway) RETURNING * INTO s;
  END IF;
  IF s.agency_id <> p_agency OR s.gateway_session_id <> p_gateway THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO t FROM public.calling_bridge_turns WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence;
  IF FOUND THEN
    IF t.request_digest <> p_request_digest OR t.kind <> (CASE WHEN p_greeting THEN 'greeting' ELSE 'utterance' END)
      THEN RAISE EXCEPTION 'calling_sequence_conflict' USING ERRCODE='23505'; END IF;
    SELECT to_jsonb(x) INTO v_turn FROM public.calling_caller_turns x WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence;
    -- A retry can read its durable caller evidence; it cannot dispatch a second assistant/action.
    RETURN jsonb_build_object('state',CASE WHEN v_turn IS NOT NULL OR p_greeting THEN 'duplicate' ELSE 'pending' END,
      'generation',t.generation,'revision',t.revision,'turn',v_turn,'can_respond',false);
  END IF;
  IF NOT v_live OR s.closing_state='terminal' OR (p_greeting AND s.closing_state='farewell_committed')
    THEN RETURN jsonb_build_object('state','terminal','can_respond',false); END IF;
  IF (SELECT count(*) FROM public.calling_bridge_turns WHERE session_id=p_session) >= 60
    THEN RAISE EXCEPTION 'calling_turn_limit'; END IF;
  IF p_sequence > s.current_sequence THEN
    UPDATE public.calling_bridge_sessions SET revision=revision+1,current_sequence=p_sequence,generation=v_generation,
      closing_state=CASE WHEN closing_state='farewell_committed' THEN 'active' ELSE closing_state END,
      farewell_id=NULL
      WHERE session_id=p_session RETURNING * INTO s;
  END IF;
  INSERT INTO public.calling_bridge_turns(agency_id,session_id,sequence,generation,revision,kind,request_digest,received_at)
    VALUES(p_agency,p_session,p_sequence,v_generation,s.revision,CASE WHEN p_greeting THEN 'greeting' ELSE 'utterance' END,p_request_digest,p_received_at)
    RETURNING * INTO t;
  RETURN jsonb_build_object('state','admitted','generation',t.generation,'revision',t.revision,'turn',NULL,
    'can_respond',s.current_sequence=p_sequence AND s.generation=t.generation);
END $$;

CREATE FUNCTION public.calling_bridge_persist_caller(p_agency uuid,p_session uuid,p_call text,p_gateway text,
  p_sequence integer,p_generation uuid,p_transcript text,p_asr_completed_at timestamptz,p_language text,p_duration_ms integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET statement_timeout = '2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; t public.calling_bridge_turns; x public.calling_caller_turns;
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency FOR UPDATE;
  SELECT * INTO t FROM public.calling_bridge_turns WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence
    AND generation=p_generation AND kind='utterance';
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_admission_required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.calling_caller_turns(agency_id,session_id,sequence,generation,transcript,received_at,asr_completed_at,language,duration_ms)
    VALUES(p_agency,p_session,p_sequence,p_generation,p_transcript,t.received_at,p_asr_completed_at,p_language,p_duration_ms)
    ON CONFLICT (agency_id,session_id,sequence) DO NOTHING;
  SELECT * INTO x FROM public.calling_caller_turns WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence;
  IF x.transcript IS DISTINCT FROM p_transcript THEN RAISE EXCEPTION 'calling_transcript_conflict' USING ERRCODE='23505'; END IF;
  -- Preserve admitted speech even when teardown or a later sequence won the race. Never reopen it.
  RETURN jsonb_build_object('state','admitted','generation',t.generation,'revision',t.revision,'turn',to_jsonb(x),
    'can_respond',c.status IN ('answer_requested','media_negotiating','answered') AND c.meta_accepted_at IS NOT NULL
      AND s.closing_state <> 'terminal' AND s.current_sequence=p_sequence AND s.generation=p_generation);
END $$;
REVOKE ALL ON FUNCTION public.calling_bridge_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_begin(uuid,uuid,text,text,integer,boolean,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_persist_caller(uuid,uuid,text,text,integer,uuid,text,timestamptz,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calling_bridge_begin(uuid,uuid,text,text,integer,boolean,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_persist_caller(uuid,uuid,text,text,integer,uuid,text,timestamptz,text,integer) TO service_role;

CREATE TABLE public.calling_bridge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  session_id uuid NOT NULL,
  sequence integer NOT NULL,
  generation uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('proposal','handoff','acknowledgement','playback_complete','action_claimed','action_verified','action_unknown','telemetry')),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agency_id,session_id,sequence,kind),
  FOREIGN KEY (agency_id,session_id,sequence) REFERENCES public.calling_bridge_turns(agency_id,session_id,sequence)
);
ALTER TABLE public.calling_bridge_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calling_bridge_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.calling_bridge_events TO service_role;
CREATE TRIGGER calling_bridge_events_immutable BEFORE UPDATE OR DELETE ON public.calling_bridge_events
  FOR EACH ROW EXECUTE FUNCTION public.calling_bridge_immutable();

CREATE FUNCTION public.calling_bridge_snapshot(p_agency uuid,p_session uuid,p_call text,p_gateway text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; v_callers jsonb; v_events jsonb;
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency;
  IF NOT FOUND THEN RETURN jsonb_build_object('legacy',true); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') INTO v_callers FROM
    (SELECT * FROM public.calling_caller_turns WHERE agency_id=p_agency AND session_id=p_session ORDER BY sequence DESC LIMIT 12) x;
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') INTO v_events FROM
    (SELECT * FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session ORDER BY sequence DESC,created_at DESC LIMIT 36) x;
  RETURN to_jsonb(s) || jsonb_build_object('callers',v_callers,'events',v_events,
    'live',c.meta_accepted_at IS NOT NULL AND c.status IN ('answer_requested','media_negotiating','answered') AND s.closing_state <> 'terminal',
    'closing_state',CASE WHEN c.status IN ('terminated','failed','missed') THEN 'terminal' ELSE s.closing_state END);
END $$;

CREATE FUNCTION public.calling_bridge_record(p_agency uuid,p_session uuid,p_call text,p_gateway text,
  p_sequence integer,p_generation uuid,p_revision bigint,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; e public.calling_bridge_events;
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency FOR UPDATE;
  IF NOT FOUND OR s.generation<>p_generation OR s.revision<>p_revision OR s.current_sequence<>p_sequence
    OR s.closing_state='terminal' OR c.status NOT IN ('answer_requested','media_negotiating','answered') OR c.meta_accepted_at IS NULL
    THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
  IF p_kind NOT IN ('proposal','handoff','acknowledgement','telemetry') THEN RAISE EXCEPTION 'calling_evidence_kind_forbidden' USING ERRCODE='42501'; END IF;
  IF p_kind='handoff' AND NOT EXISTS (SELECT 1 FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence AND kind='proposal')
    THEN RAISE EXCEPTION 'calling_proposal_required'; END IF;
  INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
    VALUES(p_agency,p_session,p_sequence,p_generation,p_kind,p_payload) ON CONFLICT DO NOTHING RETURNING * INTO e;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','already_recorded'); END IF;
  RETURN jsonb_build_object('ok',true,'id',e.id);
END $$;

CREATE FUNCTION public.calling_bridge_observe_media(p_agency uuid,p_session uuid,p_call text,p_gateway text,p_sequence integer,p_metrics jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; e public.calling_bridge_events; v_previous integer; v_complete integer;
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  v_previous := (p_metrics->>'prev_sequence')::integer;
  v_complete := (p_metrics->>'playback_complete_ms')::integer;
  IF v_previous IS NULL OR v_complete IS NULL OR v_previous<1 OR v_previous>=p_sequence OR v_complete<=0 OR v_complete>600000
    THEN RETURN jsonb_build_object('ok',false,'reason','delivery_unknown'); END IF;
  SELECT * INTO e FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND sequence=v_previous AND kind='handoff';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','handoff_unknown'); END IF;
  INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
    VALUES(p_agency,p_session,v_previous,e.generation,'playback_complete',jsonb_build_object('text',e.payload->>'text',
      'closing_question',e.payload->'closing_question','metrics',p_metrics,'evidence','gateway_playback_complete')) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.calling_bridge_snapshot(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.calling_bridge_snapshot(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb) TO service_role;
COMMIT;
