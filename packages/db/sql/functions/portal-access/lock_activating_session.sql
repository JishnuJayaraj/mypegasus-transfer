CREATE OR REPLACE FUNCTION public.lock_activating_session(p_token_hash text)
 RETURNS public.participant_session
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; c public.activation_code;
BEGIN
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
  IF NOT FOUND OR s.state <> 'activating' THEN RAISE EXCEPTION 'session_invalid'; END IF;
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id FOR UPDATE;
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT public.participant_session_live(s) THEN RAISE EXCEPTION 'session_invalid'; END IF;
  IF NOT public.activation_code_open(c) THEN RAISE EXCEPTION 'code_invalid'; END IF;
  RETURN s;
END $function$;

ALTER FUNCTION public.lock_activating_session(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_activating_session(text) FROM PUBLIC;
