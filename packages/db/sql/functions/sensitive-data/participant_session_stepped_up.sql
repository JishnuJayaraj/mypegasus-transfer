CREATE OR REPLACE FUNCTION public.participant_session_stepped_up(s public.participant_session)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT s.sensitive_step_up_at IS NOT NULL OR s.step_up_method = 'birth_date' AND EXISTS (
    SELECT FROM public.participant_account a
    WHERE a.participation_id = s.participation_id AND a.identity_assurance = 'birth_date')
$function$;

ALTER FUNCTION public.participant_session_stepped_up(public.participant_session) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participant_session_stepped_up(public.participant_session) FROM PUBLIC;
