CREATE OR REPLACE FUNCTION public.fail_step_up(s public.participant_session, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE public.participant_session SET step_up_failures = step_up_failures + 1,
    last_seen_at = now()
  WHERE token_hash = s.token_hash RETURNING step_up_failures INTO n;
  IF n < 5 THEN RETURN 'mismatch'; END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'step_up_failed'
  WHERE token_hash = s.token_hash;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'step_up_failed',
    public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('method', 'birth_date'), false);
  RETURN 'ended';
END $function$;

ALTER FUNCTION public.fail_step_up(public.participant_session,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.fail_step_up(public.participant_session,text) FROM PUBLIC;
