CREATE OR REPLACE FUNCTION public.cancel_booking_row(b public.appointment_booking, a public.appointment, p_reason public.booking_cancel_reason, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.appointment_booking SET status = 'cancelled', cancel_reason = p_reason,
    cancelled_by = CASE WHEN p_reason IN ('staff_cancelled', 'appointment_cancelled')
                        THEN (p_context).staff_user_id END,
    cancelled_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'appointment_booking_cancelled', p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('bookingId', b.id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at)), false);
END $function$;

ALTER FUNCTION public.cancel_booking_row(public.appointment_booking,public.appointment,public.booking_cancel_reason,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.cancel_booking_row(public.appointment_booking,public.appointment,public.booking_cancel_reason,public.audit_context) FROM PUBLIC;
