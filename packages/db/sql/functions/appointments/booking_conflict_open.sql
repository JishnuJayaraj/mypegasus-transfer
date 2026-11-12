CREATE OR REPLACE FUNCTION public.booking_conflict_open(b public.appointment_booking)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT b.informed_basis_at IS NOT NULL AND b.attendance::text = 'absent'
    AND b.conflict_resolution IS NULL
$function$;

ALTER FUNCTION public.booking_conflict_open(public.appointment_booking) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.booking_conflict_open(public.appointment_booking) FROM PUBLIC;
