CREATE OR REPLACE FUNCTION public.message_job_context(r public.participant_reminder, p_job_id text)
 RETURNS public.audit_context
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ROW('system', NULL, NULL,
    CASE WHEN r.kind::text IN ('appointment_changed', 'appointment_cancelled')
         THEN 'appointments.notify' ELSE 'reminders.send' END,
    NULL, NULL, p_job_id)::public.audit_context
$function$;

ALTER FUNCTION public.message_job_context(public.participant_reminder,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.message_job_context(public.participant_reminder,text) FROM PUBLIC;
