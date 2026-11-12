CREATE OR REPLACE FUNCTION public.lock_active_session(p_token_hash text)
 RETURNS public.participant_session
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; p public.participation;
BEGIN
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
  IF NOT FOUND OR s.state <> 'active' THEN RAISE EXCEPTION 'session_invalid'; END IF;
  p := public.lock_participation(s.participation_id);
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT public.participant_session_live(s) OR NOT public.participant_account_usable(p) THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  RETURN s;
END $function$;

ALTER FUNCTION public.lock_active_session(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_active_session(text) FROM PUBLIC;
