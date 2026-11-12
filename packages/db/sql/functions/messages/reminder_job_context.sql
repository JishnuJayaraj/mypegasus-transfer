CREATE OR REPLACE FUNCTION public.reminder_job_context(p_job_id text)
 RETURNS public.audit_context
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ROW('system', NULL, NULL, 'reminders.send', NULL, NULL, p_job_id)::public.audit_context
$function$;

ALTER FUNCTION public.reminder_job_context(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.reminder_job_context(text) FROM PUBLIC;
