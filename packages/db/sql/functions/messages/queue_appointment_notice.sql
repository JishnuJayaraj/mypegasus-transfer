CREATE OR REPLACE FUNCTION public.queue_appointment_notice(b public.appointment_booking, a public.appointment, p_kind public.reminder_kind, p_batch_id uuid, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE p public.participation;
BEGIN
  SELECT * INTO p FROM public.participation WHERE id = b.participation_id;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN RETURN; END IF;
  PERFORM public.queue_appointment_message(p, a, p_kind, b.id, p_batch_id,
    public.appointment_notice_context((p_context).request_id));
END $function$;

ALTER FUNCTION public.queue_appointment_notice(public.appointment_booking,public.appointment,public.reminder_kind,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.queue_appointment_notice(public.appointment_booking,public.appointment,public.reminder_kind,uuid,public.audit_context) FROM PUBLIC;
