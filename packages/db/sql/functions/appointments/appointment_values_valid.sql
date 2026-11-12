CREATE OR REPLACE FUNCTION public.appointment_values_valid(p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_booking_closes_at timestamp with time zone, p_capacity integer, p_title text, p_venue text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(p_ends_at > p_starts_at AND p_booking_closes_at <= p_starts_at
    AND p_booking_closes_at >= p_starts_at - interval '14 days'
    AND p_capacity BETWEEN 1 AND 500
    AND (p_title IS NULL OR public.appointment_text_valid(p_title, 100))
    AND public.appointment_text_valid(p_venue, 200), false)
$function$;

ALTER FUNCTION public.appointment_values_valid(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_values_valid(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text) FROM PUBLIC;
