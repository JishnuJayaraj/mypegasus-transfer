CREATE OR REPLACE FUNCTION public.check_activation_birth_date(p_token_hash text, p_birth_date date, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; c public.activation_code; v_birth date;
BEGIN
  IF p_birth_date IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF s.birth_date_checked_at IS NOT NULL OR NOT public.activation_needs_birth_date(c) THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  SELECT birth_date INTO v_birth FROM public.participant_identity
  WHERE participation_id = s.participation_id;
  IF v_birth IS NOT DISTINCT FROM p_birth_date THEN
    UPDATE public.participant_session SET birth_date_checked_at = now(), last_seen_at = now(),
      step_up_method = 'birth_date', step_up_at = now()
    WHERE token_hash = s.token_hash;
    RETURN 'ok';
  END IF;
  RETURN public.count_activation_failure(c.id, p_request_id);
END $function$;

ALTER FUNCTION public.check_activation_birth_date(text,date,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.check_activation_birth_date(text,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_activation_birth_date(text,date,text) TO transfer_app;
