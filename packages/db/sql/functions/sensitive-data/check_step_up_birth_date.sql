CREATE OR REPLACE FUNCTION public.check_step_up_birth_date(p_token_hash text, p_birth_date date, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; v_birth date;
BEGIN
  IF p_birth_date IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'birth_date' THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF public.participant_session_stepped_up(s) THEN RETURN 'ok'; END IF;
  SELECT birth_date INTO v_birth FROM public.participant_identity
  WHERE participation_id = s.participation_id;
  IF v_birth IS NOT DISTINCT FROM p_birth_date THEN
    PERFORM public.record_step_up(s, 'birth_date', p_request_id);
    RETURN 'ok';
  END IF;
  RETURN public.fail_step_up(s, p_request_id);
END $function$;

ALTER FUNCTION public.check_step_up_birth_date(text,date,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.check_step_up_birth_date(text,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_step_up_birth_date(text,date,text) TO transfer_app;
