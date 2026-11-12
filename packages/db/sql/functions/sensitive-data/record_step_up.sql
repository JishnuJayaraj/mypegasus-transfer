CREATE OR REPLACE FUNCTION public.record_step_up(s public.participant_session, p_method public.sensitive_step_up_method, p_request_id text, p_challenge_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.participant_session SET sensitive_step_up_method = p_method,
    sensitive_step_up_at = now(), last_seen_at = now()
  WHERE token_hash = s.token_hash;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'step_up_completed',
    public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('method', p_method,
      'challengeId', p_challenge_id)), false);
END $function$;

ALTER FUNCTION public.record_step_up(public.participant_session,public.sensitive_step_up_method,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_step_up(public.participant_session,public.sensitive_step_up_method,text,uuid) FROM PUBLIC;
