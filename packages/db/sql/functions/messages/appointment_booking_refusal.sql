CREATE OR REPLACE FUNCTION public.appointment_booking_refusal(p public.participation, a public.appointment, p_participant boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF a.status = 'cancelled' THEN RETURN 'appointment_cancelled'; END IF;
  IF a.starts_at <= now() THEN RETURN 'appointment_started'; END IF;
  IF p_participant AND a.booking_closes_at <= now() THEN RETURN 'booking_closed'; END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN RETURN 'participation_closed'; END IF;
  IF a.kind = 'info_event' AND (
       p.status NOT IN ('imported', 'contacted', 'unreachable', 'informed')
       OR a.audience_wave_id IS NOT NULL AND a.audience_wave_id IS DISTINCT FROM p.entry_wave_id) THEN
    RETURN 'not_in_audience';
  END IF;
  IF a.kind = 'consultation' AND NOT public.appointment_staff_allowed(p.id, a.host_staff_user_id) THEN
    RETURN 'host_not_responsible';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking
             WHERE appointment_id = a.id AND participation_id = p.id AND status = 'booked') THEN
    RETURN 'already_booked';
  END IF;
  IF a.kind = 'info_event' AND EXISTS (
       SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
       WHERE b.participation_id = p.id AND b.status = 'booked' AND x.kind = 'info_event'
         AND x.ends_at > now()) THEN
    RETURN 'info_event_limit';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
             WHERE b.participation_id = p.id AND b.status = 'booked'
               AND x.starts_at < a.ends_at AND a.starts_at < x.ends_at) THEN
    RETURN 'booking_overlap';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.appointment_booking
      WHERE appointment_id = a.id AND status = 'booked') >= a.capacity THEN
    RETURN 'appointment_full';
  END IF;
  IF NOT public.participation_before_cutoff(p) THEN RETURN 'after_cutoff'; END IF;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.appointment_booking_refusal(public.participation,public.appointment,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_booking_refusal(public.participation,public.appointment,boolean) FROM PUBLIC;
