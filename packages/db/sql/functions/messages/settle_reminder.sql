CREATE OR REPLACE FUNCTION public.settle_reminder(r public.participant_reminder, p_status public.reminder_status, p_cancel_reason public.reminder_cancel_reason, p_job_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.participant_reminder SET status = p_status, cancel_reason = p_cancel_reason,
    outcome_at = now()
  WHERE id = r.id;
  PERFORM public.write_audit_event(r.project_id, r.participation_id, 'reminder_delivery',
    public.message_job_context(r, p_job_id), NULL, NULL, NULL, p_cancel_reason::text, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('reminderId', r.id,
      'outcome', p_status, 'kind', r.kind, 'appointmentId', r.appointment_id)), false);
END $function$;

ALTER FUNCTION public.settle_reminder(public.participant_reminder,public.reminder_status,public.reminder_cancel_reason,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.settle_reminder(public.participant_reminder,public.reminder_status,public.reminder_cancel_reason,text) FROM PUBLIC;
