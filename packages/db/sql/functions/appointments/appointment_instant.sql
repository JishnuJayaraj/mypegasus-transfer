CREATE OR REPLACE FUNCTION public.appointment_instant(p_at timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$function$;

ALTER FUNCTION public.appointment_instant(timestamp with time zone) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_instant(timestamp with time zone) FROM PUBLIC;
