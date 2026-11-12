CREATE OR REPLACE FUNCTION public.participant_context(p_participation_id uuid, p_request_id text)
 RETURNS public.audit_context
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ROW('participant', NULL, p_participation_id, NULL, NULL, p_request_id, NULL)::public.audit_context
$function$;

ALTER FUNCTION public.participant_context(uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participant_context(uuid,text) FROM PUBLIC;
