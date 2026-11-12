CREATE OR REPLACE FUNCTION public.verify_step_up_code(p_token_hash text, p_code_hash text, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; v_result text; v_challenge uuid;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'photo_id_and_code' THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF public.participant_session_stepped_up(s) THEN RETURN 'ok'; END IF;
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(s.participation_id,
    'step_up', p_code_hash, p_request_id);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  PERFORM public.record_step_up(s, 'photo_id_and_code', p_request_id, v_challenge);
  RETURN 'ok';
END $function$;

ALTER FUNCTION public.verify_step_up_code(text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.verify_step_up_code(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_step_up_code(text,text,text) TO transfer_app;
