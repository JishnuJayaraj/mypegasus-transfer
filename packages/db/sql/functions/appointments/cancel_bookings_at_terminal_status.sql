CREATE OR REPLACE FUNCTION public.cancel_bookings_at_terminal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.appointment_booking;
  a public.appointment;
BEGIN
  IF NEW.status IN ('withdrawn', 'ta_completed', 'exited')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR b IN SELECT bk.* FROM public.appointment_booking bk
             JOIN public.appointment x ON x.id = bk.appointment_id
             WHERE bk.participation_id = NEW.id AND bk.status = 'booked' AND x.starts_at > now()
             ORDER BY bk.id FOR UPDATE OF bk LOOP
      SELECT * INTO a FROM public.appointment WHERE id = b.appointment_id;
      PERFORM public.cancel_booking_row(b, a, 'participation_closed',
        ROW('system', NULL, NULL, 'terminal-booking-cancellation', NULL, NULL, NULL)::public.audit_context);
    END LOOP;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.cancel_bookings_at_terminal_status() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.cancel_bookings_at_terminal_status() FROM PUBLIC;
