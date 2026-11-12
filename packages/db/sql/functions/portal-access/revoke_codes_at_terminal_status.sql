CREATE OR REPLACE FUNCTION public.revoke_codes_at_terminal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c record;
BEGIN
  IF NEW.status IN ('withdrawn', 'ta_completed', 'exited')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR c IN UPDATE public.activation_code SET revoked_at = now(), revoked_by = NULL,
      revoke_reason = 'participation_closed'
      WHERE participation_id = NEW.id AND revoked_at IS NULL AND locked_at IS NULL AND used_at IS NULL
      RETURNING id
    LOOP
      INSERT INTO public.audit_event (project_id, participation_id, event_type, actor_type,
        system_job, reason_code, details)
      VALUES (NEW.project_id, NEW.id, 'activation_code_revoked', 'system',
        'terminal-code-revocation', 'participation_closed',
        pg_catalog.jsonb_build_object('activationCodeId', c.id));
    END LOOP;
    UPDATE public.participant_session SET ended_at = now(), end_reason = 'participation_closed'
    WHERE participation_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.revoke_codes_at_terminal_status() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.revoke_codes_at_terminal_status() FROM PUBLIC;
