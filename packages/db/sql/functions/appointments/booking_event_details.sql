CREATE OR REPLACE FUNCTION public.booking_event_details(b public.appointment_booking, a public.appointment)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_build_object('bookingId', b.id, 'appointmentId', a.id,
    'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at))
$function$;

ALTER FUNCTION public.booking_event_details(public.appointment_booking,public.appointment) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.booking_event_details(public.appointment_booking,public.appointment) FROM PUBLIC;
