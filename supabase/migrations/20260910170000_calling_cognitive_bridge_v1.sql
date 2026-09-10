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
    IF NOT p_greeting OR coalesce(c.turn_count,0)>0 OR c.disclosure_spoken IS TRUE THEN RETURN jsonb_build_object('state','legacy','can_respond',false); END IF;
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
      closing_episode=CASE WHEN closing_state='farewell_committed' THEN NULL ELSE closing_episode END,
      closing_clarifications=CASE WHEN closing_state='farewell_committed' THEN 0 ELSE closing_clarifications END,
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
  PERFORM public.calling_bridge_project(p_agency,p_session);
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
    'actions',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM (SELECT id,quotation_id,state,receipt,claimed_at,completed_at FROM public.calling_bridge_actions WHERE agency_id=p_agency AND session_id=p_session ORDER BY claimed_at DESC LIMIT 6) a),
    'live',c.meta_accepted_at IS NOT NULL AND c.status IN ('answer_requested','media_negotiating','answered') AND s.closing_state <> 'terminal',
    'closing_state',CASE WHEN c.status IN ('terminated','failed','missed','completed','rejected') THEN 'terminal' ELSE s.closing_state END);
END $$;

CREATE FUNCTION public.calling_bridge_record(p_agency uuid,p_session uuid,p_call text,p_gateway text,
  p_sequence integer,p_generation uuid,p_revision bigint,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; e public.calling_bridge_events;
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.calling_bridge_turns WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence AND generation=p_generation)
    THEN RETURN jsonb_build_object('ok',false,'reason','unknown_owner'); END IF;
  IF p_kind NOT IN ('handoff','telemetry') AND (s.generation<>p_generation OR s.revision<>p_revision OR s.current_sequence<>p_sequence
    OR s.closing_state='terminal' OR c.status NOT IN ('answer_requested','media_negotiating','answered') OR c.meta_accepted_at IS NULL)
    THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
  IF p_kind NOT IN ('proposal','handoff','acknowledgement','telemetry') THEN RAISE EXCEPTION 'calling_evidence_kind_forbidden' USING ERRCODE='42501'; END IF;
  IF p_kind='handoff' AND NOT EXISTS (SELECT 1 FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence AND kind='proposal')
    THEN RAISE EXCEPTION 'calling_proposal_required'; END IF;
  IF p_kind='handoff' THEN SELECT payload INTO p_payload FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence AND kind='proposal'; END IF;
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
  PERFORM public.calling_bridge_project(p_agency,p_session);
  RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.calling_bridge_snapshot(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.calling_bridge_snapshot(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb) TO service_role;

-- Versioned Calling action ownership. A claimed or unknown action is never retried automatically.
CREATE TABLE public.calling_bridge_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agency_id uuid NOT NULL, session_id uuid NOT NULL,
 sequence integer NOT NULL, generation uuid NOT NULL, quotation_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('claimed','dispatching','verified_success','verified_failure','cancelled','timeout','outcome_unknown')),
 receipt jsonb, cause text, claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), dispatched_at timestamptz, completed_at timestamptz,
 UNIQUE(agency_id,session_id,quotation_id),
 FOREIGN KEY(agency_id,session_id,sequence) REFERENCES public.calling_bridge_turns(agency_id,session_id,sequence)
);
ALTER TABLE public.calling_bridge_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calling_bridge_actions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.calling_bridge_actions TO service_role;

-- Acquiring the call row before bridge state gives all admissions, closes and dispatches one lock order.
CREATE FUNCTION public.calling_bridge_action(p_agency uuid,p_session uuid,p_call text,p_gateway text,
 p_sequence integer,p_generation uuid,p_revision bigint,p_quotation uuid,p_operation text,p_result jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; a public.calling_bridge_actions; v_state text; v_receipt jsonb;
BEGIN
 SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.calling_bridge_sessions WHERE agency_id=p_agency AND session_id=p_session FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'calling_admission_required'; END IF;
 SELECT * INTO a FROM public.calling_bridge_actions WHERE agency_id=p_agency AND session_id=p_session AND quotation_id=p_quotation FOR UPDATE;
 IF p_operation='reconcile' THEN
   IF a.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','unknown_action'); END IF;
   IF a.state='verified_success' THEN RETURN jsonb_build_object('ok',true,'outcome',a.state,'receipt',a.receipt); END IF;
   SELECT jsonb_build_object('messageId',m.id,'providerMessageId',m.provider_message_id,'quotationId',p_quotation) INTO v_receipt
     FROM public.ai_tasks t JOIN public.messages m ON m.id=t.id AND m.agency_id=t.agency_id
     WHERE t.agency_id=p_agency AND t.kind='deliver_existing_quotation_whatsapp' AND t.input->>'call_id'=p_call
       AND t.input->>'quotation_id'=p_quotation::text AND t.input->>'conversation_id'=m.conversation_id::text
       AND t.output->>'providerMessageId'=m.provider_message_id AND m.delivery_status IN ('sent','delivered','read') AND length(m.provider_message_id)>0 LIMIT 1;
   IF v_receipt IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','outcome_unknown'); END IF;
   UPDATE public.ai_tasks SET status='completed',output=v_receipt,error=NULL,completed_at=clock_timestamp()
     WHERE agency_id=p_agency AND id=(v_receipt->>'messageId')::uuid;
   UPDATE public.calling_bridge_actions SET state='verified_success',receipt=v_receipt,cause=NULL,completed_at=clock_timestamp() WHERE id=a.id;
   INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
     VALUES(p_agency,p_session,a.sequence,a.generation,'action_verified',jsonb_build_object('action_id',a.id,'outcome','verified_success','receipt',v_receipt,'reconciled',true)) ON CONFLICT DO NOTHING;
   RETURN jsonb_build_object('ok',true,'outcome','verified_success','receipt',v_receipt);
 END IF;
 IF p_operation='finish' THEN
   -- Only the originating execution owner can record an outcome, including after teardown/supersession.
   IF a.id IS NULL OR a.sequence<>p_sequence OR a.generation<>p_generation THEN RAISE EXCEPTION 'calling_action_owner_mismatch' USING ERRCODE='42501'; END IF;
   IF a.state IN ('verified_success','verified_failure','cancelled','timeout') THEN RETURN jsonb_build_object('ok',false,'reason','already_finished'); END IF;
   v_state := p_result->>'outcome'; v_receipt := p_result->'receipt';
   IF v_state NOT IN ('verified_success','verified_failure','cancelled','timeout','outcome_unknown') OR v_state IS NULL THEN RAISE EXCEPTION 'calling_action_outcome_invalid'; END IF;
   IF a.state='dispatching' AND v_state IN ('cancelled','timeout') AND p_result->'dispatched' IS DISTINCT FROM 'false'::jsonb THEN v_state:='outcome_unknown'; END IF;
   IF v_state='verified_success' THEN
     IF NOT EXISTS (SELECT 1 FROM public.ai_tasks t JOIN public.messages m ON m.id=t.id AND m.agency_id=t.agency_id
       WHERE t.agency_id=p_agency AND t.id=(v_receipt->>'messageId')::uuid AND t.status='completed'
         AND t.kind='deliver_existing_quotation_whatsapp' AND t.input->>'call_id'=p_call
         AND t.input->>'quotation_id'=p_quotation::text AND t.input->>'conversation_id'=m.conversation_id::text AND t.output->>'providerMessageId'=v_receipt->>'providerMessageId'
         AND m.delivery_status IN ('sent','delivered','read') AND length(m.provider_message_id)>0 AND m.provider_message_id=v_receipt->>'providerMessageId')
       THEN RAISE EXCEPTION 'calling_verified_receipt_required' USING ERRCODE='42501'; END IF;
   END IF;
   UPDATE public.calling_bridge_actions SET state=v_state,receipt=v_receipt,cause=left(p_result->>'cause',120),completed_at=clock_timestamp() WHERE id=a.id;
   INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
     VALUES(p_agency,p_session,p_sequence,p_generation,CASE WHEN v_state='verified_success' THEN 'action_verified' ELSE 'action_unknown' END,
       jsonb_build_object('action_id',a.id,'outcome',v_state,'receipt',v_receipt,'cause',left(p_result->>'cause',120))) ON CONFLICT DO NOTHING;
   RETURN jsonb_build_object('ok',true,'outcome',v_state,'receipt',v_receipt);
 END IF;
 IF s.generation<>p_generation OR s.revision<>p_revision OR s.current_sequence<>p_sequence OR s.closing_state IN ('terminal','farewell_committed')
   OR c.status NOT IN ('answer_requested','media_negotiating','answered') OR c.meta_accepted_at IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
 IF p_operation='claim' THEN
   IF a.id IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'reason','already_claimed','outcome',a.state,'receipt',a.receipt); END IF;
   INSERT INTO public.calling_bridge_actions(agency_id,session_id,sequence,generation,quotation_id,state)
     VALUES(p_agency,p_session,p_sequence,p_generation,p_quotation,'claimed') RETURNING * INTO a;
   INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
     VALUES(p_agency,p_session,p_sequence,p_generation,'action_claimed',jsonb_build_object('action_id',a.id,'quotation_id',p_quotation));
   RETURN jsonb_build_object('ok',true,'id',a.id);
 ELSIF p_operation='dispatch' THEN
   IF a.id IS NULL OR a.sequence<>p_sequence OR a.generation<>p_generation OR a.state<>'claimed' THEN RETURN jsonb_build_object('ok',false,'reason','dispatch_already_claimed'); END IF;
   UPDATE public.calling_bridge_actions SET state='dispatching',dispatched_at=clock_timestamp() WHERE id=a.id;
   RETURN jsonb_build_object('ok',true);
 END IF;
 RAISE EXCEPTION 'calling_action_operation_invalid';
END $$;

-- Rollback-compatible projection. Caller input is retained immediately; only observed playback qualifies assistant history.
CREATE FUNCTION public.calling_bridge_project(p_agency uuid,p_session uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.whatsapp_call_sessions SET transcript=(SELECT coalesce(jsonb_agg(v ORDER BY seq,actor),'[]') FROM (
   SELECT sequence seq,0 actor,jsonb_build_object('role','customer','text',transcript,'at',persisted_at,'sequence',sequence,'duration_ms',duration_ms) v
     FROM public.calling_caller_turns WHERE agency_id=p_agency AND session_id=p_session
   UNION ALL
   SELECT e.sequence,1,jsonb_build_object('role','umraio','text',e.payload->>'text','at',e.created_at,'sequence',e.sequence,
       'delivery',CASE WHEN EXISTS(SELECT 1 FROM public.calling_bridge_events p WHERE p.agency_id=p_agency AND p.session_id=p_session AND p.sequence=e.sequence AND p.kind='playback_complete') THEN 'playback_complete' ELSE 'generated' END)
     FROM public.calling_bridge_events e WHERE e.agency_id=p_agency AND e.session_id=p_session AND e.kind='proposal'
 ) turns), turn_count=(SELECT count(*) FROM public.calling_bridge_turns WHERE agency_id=p_agency AND session_id=p_session)
 WHERE id=p_session AND agency_id=p_agency;
 UPDATE public.whatsapp_call_sessions SET call_summary=(SELECT '[Calling: caller statements and observed playback; not business/action verification]' || E'\n' || coalesce(string_agg(line,E'\n' ORDER BY seq,actor),'') FROM (
   SELECT sequence seq,0 actor,'Caller: '||left(transcript,500) line FROM (SELECT * FROM public.calling_caller_turns WHERE agency_id=p_agency AND session_id=p_session ORDER BY sequence DESC LIMIT 4) c
   UNION ALL SELECT sequence,1,'Delivered RAIŌ: '||left(payload->>'text',500) FROM (SELECT * FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND kind='playback_complete' ORDER BY sequence DESC LIMIT 3) e
 ) history) WHERE id=p_session AND agency_id=p_agency;
END $$;

CREATE FUNCTION public.calling_bridge_output(p_agency uuid,p_session uuid,p_call text,p_gateway text,
 p_sequence integer,p_generation uuid,p_revision bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; v_next text; v_farewell uuid; v_item jsonb; v_caller public.calling_caller_turns; v_memory jsonb;
BEGIN
 SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency FOR UPDATE;
 IF NOT FOUND OR s.generation<>p_generation OR s.revision<>p_revision OR s.current_sequence<>p_sequence OR s.closing_state IN ('terminal','farewell_committed')
   OR c.status NOT IN ('answer_requested','media_negotiating','answered') OR c.meta_accepted_at IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
 IF EXISTS(SELECT 1 FROM public.calling_bridge_events WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence AND kind='proposal') THEN RETURN jsonb_build_object('ok',false,'reason','already_committed'); END IF;
 v_next:=p_payload->>'next_state';
 IF v_next IS NULL OR v_next NOT IN ('active','possible_completion','farewell_committed') OR length(btrim(p_payload->>'text')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'calling_output_invalid'; END IF;
 IF v_next='possible_completion' AND s.closing_clarifications>=1 THEN RETURN jsonb_build_object('ok',false,'reason','closing_clarification_used'); END IF;
 IF v_next='farewell_committed' THEN v_farewell:=gen_random_uuid(); END IF;
 SELECT * INTO v_caller FROM public.calling_caller_turns WHERE agency_id=p_agency AND session_id=p_session AND sequence=p_sequence;
 v_memory:=coalesce(p_payload->'memory_update','{}');
 FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(v_memory->'corrections','[]') || coalesce(v_memory->'open_questions','[]') ||
    CASE WHEN v_memory->'objective' IS NOT NULL AND v_memory->'objective'<>'null'::jsonb THEN jsonb_build_array(v_memory->'objective') ELSE '[]'::jsonb END) LOOP
   IF v_caller.id IS NULL OR v_item->>'text' IS DISTINCT FROM v_item->>'evidence_quote' OR length(v_item->>'text') NOT BETWEEN 1 AND 500
     OR position(v_item->>'text' in v_caller.transcript)=0 OR NOT(v_item->'source_refs' ? ('caller:'||v_caller.id::text)) THEN RAISE EXCEPTION 'calling_memory_evidence_required'; END IF;
 END LOOP;
 IF v_memory->'objective' IS NOT NULL AND v_memory->'objective'<>'null'::jsonb THEN
   v_memory:=jsonb_set(v_memory,'{objective}',v_memory->'objective'||jsonb_build_object('observed_at',v_caller.persisted_at));
 END IF;
 v_memory:=jsonb_set(v_memory,'{corrections}',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('observed_at',v_caller.persisted_at)),'[]') FROM jsonb_array_elements(coalesce(v_memory->'corrections','[]'))));
 v_memory:=jsonb_set(v_memory,'{open_questions}',(SELECT coalesce(jsonb_agg(value||jsonb_build_object('observed_at',v_caller.persisted_at)),'[]') FROM jsonb_array_elements(coalesce(v_memory->'open_questions','[]'))));
 UPDATE public.calling_bridge_sessions SET closing_state=v_next,
   closing_episode=CASE WHEN v_next IN ('possible_completion','farewell_committed') THEN coalesce(closing_episode,gen_random_uuid()) ELSE closing_episode END,
   closing_clarifications=CASE WHEN v_next='possible_completion' THEN 1 ELSE closing_clarifications END,farewell_id=v_farewell,
   memory=jsonb_build_object('objective',CASE WHEN v_memory->'objective' IS NULL OR v_memory->'objective'='null'::jsonb THEN memory->'objective' ELSE v_memory->'objective' END,
     'corrections',(SELECT coalesce(jsonb_agg(item),'[]') FROM (SELECT item FROM jsonb_array_elements(coalesce(memory->'corrections','[]') || coalesce(v_memory->'corrections','[]')) WITH ORDINALITY AS q(item,ord) ORDER BY ord DESC LIMIT 6) x),
     'open_questions',coalesce(v_memory->'open_questions',memory->'open_questions','[]')) WHERE session_id=p_session;
 INSERT INTO public.calling_bridge_events(agency_id,session_id,sequence,generation,kind,payload)
   VALUES(p_agency,p_session,p_sequence,p_generation,'proposal',p_payload || jsonb_build_object('farewell_id',v_farewell));
 UPDATE public.whatsapp_call_sessions SET closing_state=CASE WHEN v_next='farewell_committed' THEN 'farewell' WHEN v_next='possible_completion' THEN 'completion_check' ELSE 'active' END,
   disclosure_spoken=disclosure_spoken OR (p_payload->>'greeting')::boolean IS TRUE,detected_language=p_payload->>'language',
   lead_id=coalesce(lead_id,(SELECT id FROM public.leads WHERE agency_id=p_agency AND id::text=p_payload->>'lead_id')),
   conversation_id=coalesce(conversation_id,(SELECT id FROM public.conversations WHERE agency_id=p_agency AND lead_id::text=p_payload->>'lead_id' AND id::text=p_payload->>'conversation_id'))
   WHERE id=p_session;
 PERFORM public.calling_bridge_project(p_agency,p_session);
 RETURN jsonb_build_object('ok',true,'farewell_id',v_farewell);
END $$;

REVOKE ALL ON FUNCTION public.calling_bridge_action(uuid,uuid,text,text,integer,uuid,bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_output(uuid,uuid,text,text,integer,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calling_bridge_project(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_action(uuid,uuid,text,text,integer,uuid,bigint,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.calling_bridge_output(uuid,uuid,text,text,integer,uuid,bigint,jsonb) TO service_role;

-- Normalize only the new Bridge objects: deployment defaults may grant direct writes.
-- The Worker reads tables and invokes bound RPCs; helpers remain owner-only.
DO $calling_bridge_privileges$
DECLARE target record; principal record;
BEGIN
  FOR target IN
    SELECT 'TABLE' AS kind, c.oid::regclass::text AS identity, c.relowner AS owner,
      coalesce(c.relacl,acldefault('r',c.relowner)) AS acl
    FROM pg_class c WHERE c.oid=ANY(ARRAY[
      'public.calling_bridge_sessions','public.calling_bridge_turns','public.calling_caller_turns',
      'public.calling_bridge_events','public.calling_bridge_actions']::regclass[])
    UNION ALL
    SELECT 'FUNCTION',p.oid::regprocedure::text,p.proowner,coalesce(p.proacl,acldefault('f',p.proowner))
    FROM pg_proc p WHERE p.oid=ANY(ARRAY[
      'public.calling_bridge_immutable()',
      'public.calling_bridge_begin(uuid,uuid,text,text,integer,boolean,timestamptz,text)',
      'public.calling_bridge_persist_caller(uuid,uuid,text,text,integer,uuid,text,timestamptz,text,integer)',
      'public.calling_bridge_snapshot(uuid,uuid,text,text)',
      'public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb)',
      'public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb)',
      'public.calling_bridge_action(uuid,uuid,text,text,integer,uuid,bigint,uuid,text,jsonb)',
      'public.calling_bridge_output(uuid,uuid,text,text,integer,uuid,bigint,jsonb)',
      'public.calling_bridge_project(uuid,uuid)']::regprocedure[])
  LOOP
    FOR principal IN SELECT DISTINCT grantee FROM aclexplode(target.acl) WHERE grantee<>target.owner LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON %s %s FROM %s',target.kind,target.identity,
        CASE WHEN principal.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(principal.grantee)) END);
    END LOOP;
  END LOOP;
END $calling_bridge_privileges$;
GRANT SELECT ON public.calling_bridge_sessions,public.calling_bridge_turns,public.calling_caller_turns,
  public.calling_bridge_events,public.calling_bridge_actions TO service_role;
GRANT EXECUTE ON FUNCTION
  public.calling_bridge_begin(uuid,uuid,text,text,integer,boolean,timestamptz,text),
  public.calling_bridge_persist_caller(uuid,uuid,text,text,integer,uuid,text,timestamptz,text,integer),
  public.calling_bridge_snapshot(uuid,uuid,text,text),
  public.calling_bridge_record(uuid,uuid,text,text,integer,uuid,bigint,text,jsonb),
  public.calling_bridge_observe_media(uuid,uuid,text,text,integer,jsonb),
  public.calling_bridge_action(uuid,uuid,text,text,integer,uuid,bigint,uuid,text,jsonb),
  public.calling_bridge_output(uuid,uuid,text,text,integer,uuid,bigint,jsonb) TO service_role;

COMMIT;
