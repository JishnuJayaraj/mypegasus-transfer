CREATE OR REPLACE FUNCTION public.berlin_today()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date
$function$;

ALTER FUNCTION public.berlin_today() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.berlin_today() FROM PUBLIC;
