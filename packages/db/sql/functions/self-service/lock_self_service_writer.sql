CREATE OR REPLACE FUNCTION public.lock_self_service_writer(p_participation_id uuid, p_context public.audit_context, p_token_hash text)
 RETURNS public.participation
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; s public.participant_session;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF (p_context).actor_type = 'user' THEN
    PERFORM public.lock_assisted_mode(p_participation_id, p_context, p_token_hash);
    RETURN r;
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF s.participation_id <> p_participation_id THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  RETURN r;
END $function$;

ALTER FUNCTION public.lock_self_service_writer(uuid,public.audit_context,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_self_service_writer(uuid,public.audit_context,text) FROM PUBLIC;
