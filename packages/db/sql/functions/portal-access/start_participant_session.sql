CREATE OR REPLACE FUNCTION public.start_participant_session(p_kind public.contact_channel_kind, p_address text, p_code_hash text, p_token_hash text, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE ch public.participant_channel; p public.participation; v_result text; v_challenge uuid;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE kind = p_kind AND address = p_address AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN 'one_time_code_invalid'; END IF;
  p := public.lock_participation(ch.participation_id);
  SELECT * INTO ch FROM public.participant_channel WHERE id = ch.id;
  IF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL
     OR NOT public.participant_account_usable(p) THEN
    RETURN 'one_time_code_invalid';
  END IF;
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(p.id, 'login',
    p_code_hash, p_request_id, p_kind, p_address);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  INSERT INTO public.participant_session (
    token_hash, project_id, participation_id, state, step_up_method, step_up_at)
  VALUES (p_token_hash, p.project_id, p.id, 'active', 'one_time_code', now());
  PERFORM public.write_audit_event(p.project_id, p.id, 'participant_login',
    public.participant_context(p.id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('method', 'one_time_code', 'channelId', ch.id), false);
  RETURN 'ok';
END $function$;

ALTER FUNCTION public.start_participant_session(public.contact_channel_kind,text,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.start_participant_session(public.contact_channel_kind,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_participant_session(public.contact_channel_kind,text,text,text,text) TO transfer_app;
