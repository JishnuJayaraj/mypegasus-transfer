CREATE OR REPLACE FUNCTION public.booking_missed(b public.appointment_booking)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT b.status = 'booked' AND b.attendance IS NOT DISTINCT FROM 'absent'
    AND b.informed_basis_at IS NULL
    AND b.missed_resolution IS NULL
    AND EXISTS (SELECT FROM public.appointment a WHERE a.id = b.appointment_id
                AND a.status = 'scheduled')
    AND NOT EXISTS (
      SELECT FROM public.appointment a
      JOIN public.appointment_booking f ON f.participation_id = b.participation_id
        AND f.id <> b.id AND f.status = 'booked'
      JOIN public.appointment x ON x.id = f.appointment_id AND x.status = 'scheduled'
      WHERE a.id = b.appointment_id
        AND CASE WHEN a.kind = 'consultation' THEN f.follow_up_of = b.id
                 ELSE x.kind = 'info_event' AND x.starts_at > a.starts_at END)
$function$;

ALTER FUNCTION public.booking_missed(public.appointment_booking) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.booking_missed(public.appointment_booking) FROM PUBLIC;
