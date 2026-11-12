CREATE OR REPLACE FUNCTION public.lock_admin_survivorship()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('staff:admin-survivorship', 0));
END $function$;

ALTER FUNCTION public.lock_admin_survivorship() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_admin_survivorship() FROM PUBLIC;
