CREATE OR REPLACE FUNCTION public.count_activation_failure(p_activation_code_id uuid, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c public.activation_code;
BEGIN
  UPDATE public.activation_code SET failed_attempts = failed_attempts + 1,
    locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN now() END
  WHERE id = p_activation_code_id RETURNING * INTO c;
  IF c.locked_at IS NULL THEN RETURN 'mismatch'; END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'code_closed'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_locked',
    public.portal_system_context(p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('activationCodeId', c.id), false);
  RETURN 'locked';
END $function$;

ALTER FUNCTION public.count_activation_failure(uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.count_activation_failure(uuid,text) FROM PUBLIC;
