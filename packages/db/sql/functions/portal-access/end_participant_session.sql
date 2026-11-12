CREATE OR REPLACE FUNCTION public.end_participant_session(p_token_hash text, p_request_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session;
BEGIN
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'logout'
  WHERE token_hash = p_token_hash AND ended_at IS NULL RETURNING * INTO s;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.state = 'active' THEN
    PERFORM public.write_audit_event(s.project_id, s.participation_id, 'participant_logout',
      public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
      '{}'::jsonb, false);
  END IF;
  RETURN true;
END $function$;

ALTER FUNCTION public.end_participant_session(text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.end_participant_session(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_participant_session(text,text) TO transfer_app;
