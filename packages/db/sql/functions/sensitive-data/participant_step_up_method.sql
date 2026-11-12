CREATE OR REPLACE FUNCTION public.participant_step_up_method(p_participation_id uuid)
 RETURNS public.sensitive_step_up_method
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE a.identity_assurance WHEN 'birth_date' THEN 'birth_date'
    ELSE 'photo_id_and_code' END::public.sensitive_step_up_method
  FROM public.participant_account a WHERE a.participation_id = p_participation_id
$function$;

ALTER FUNCTION public.participant_step_up_method(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participant_step_up_method(uuid) FROM PUBLIC;
