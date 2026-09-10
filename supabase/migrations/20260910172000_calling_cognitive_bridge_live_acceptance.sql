-- Calling-only lifecycle alignment. Meta acceptance can precede media readiness
-- while the existing call status remains meta_pre_accepted. Every live check
-- still requires meta_accepted_at; do not promote the call to answered.
-- CREATE OR REPLACE preserves the existing function owners and privilege locks.
BEGIN;

CREATE OR REPLACE FUNCTION public.calling_bridge_begin(p_agency uuid, p_session uuid, p_call text, p_gateway text,
  p_sequence integer, p_greeting boolean, p_received_at timestamptz, p_request_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET statement_timeout = '2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; t public.calling_bridge_turns;
  v_turn jsonb; v_live boolean; v_generation uuid := gen_random_uuid();
BEGIN
  SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency
    AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
  v_live := c.meta_accepted_at IS NOT NULL AND c.status IN ('answer_requested','media_negotiating','meta_pre_accepted','answered');
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

CREATE OR REPLACE FUNCTION public.calling_bridge_snapshot(p_agency uuid,p_session uuid,p_call text,p_gateway text)
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
    'live',c.meta_accepted_at IS NOT NULL AND c.status IN ('answer_requested','media_negotiating','meta_pre_accepted','answered') AND s.closing_state <> 'terminal',
    'closing_state',CASE WHEN c.status IN ('terminated','failed','missed','completed','rejected') THEN 'terminal' ELSE s.closing_state END);
END $$;

CREATE OR REPLACE FUNCTION public.calling_bridge_persist_caller(p_agency uuid,p_session uuid,p_call text,p_gateway text,
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
    'can_respond',c.status IN ('answer_requested','media_negotiating','meta_pre_accepted','answered') AND c.meta_accepted_at IS NOT NULL
      AND s.closing_state <> 'terminal' AND s.current_sequence=p_sequence AND s.generation=p_generation);
END $$;

CREATE OR REPLACE FUNCTION public.calling_bridge_record(p_agency uuid,p_session uuid,p_call text,p_gateway text,
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
    OR s.closing_state='terminal' OR c.status NOT IN ('answer_requested','media_negotiating','meta_pre_accepted','answered') OR c.meta_accepted_at IS NULL)
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

CREATE OR REPLACE FUNCTION public.calling_bridge_output(p_agency uuid,p_session uuid,p_call text,p_gateway text,
 p_sequence integer,p_generation uuid,p_revision bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2500ms' AS $$
DECLARE c public.whatsapp_call_sessions; s public.calling_bridge_sessions; v_next text; v_farewell uuid; v_item jsonb; v_caller public.calling_caller_turns; v_memory jsonb;
BEGIN
 SELECT * INTO c FROM public.whatsapp_call_sessions WHERE id=p_session AND agency_id=p_agency AND call_id=p_call AND gateway_session_id=p_gateway FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'calling_binding_mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.calling_bridge_sessions WHERE session_id=p_session AND agency_id=p_agency FOR UPDATE;
 IF NOT FOUND OR s.generation<>p_generation OR s.revision<>p_revision OR s.current_sequence<>p_sequence OR s.closing_state IN ('terminal','farewell_committed')
   OR c.status NOT IN ('answer_requested','media_negotiating','meta_pre_accepted','answered') OR c.meta_accepted_at IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
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

CREATE OR REPLACE FUNCTION public.calling_bridge_action(p_agency uuid,p_session uuid,p_call text,p_gateway text,
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
   OR c.status NOT IN ('answer_requested','media_negotiating','meta_pre_accepted','answered') OR c.meta_accepted_at IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','stale_turn'); END IF;
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

COMMIT;
