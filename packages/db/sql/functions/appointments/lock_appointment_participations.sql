CREATE OR REPLACE FUNCTION public.lock_appointment_participations(p_appointment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM FROM public.participation q
  WHERE q.id IN (SELECT b.participation_id FROM public.appointment_booking b
                 WHERE b.appointment_id = p_appointment_id AND b.status = 'booked')
  ORDER BY q.id FOR UPDATE;
END $function$;

ALTER FUNCTION public.lock_appointment_participations(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_appointment_participations(uuid) FROM PUBLIC;
