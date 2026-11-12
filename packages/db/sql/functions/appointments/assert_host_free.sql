CREATE OR REPLACE FUNCTION public.assert_host_free(p_host uuid, p_appointment_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('appointment-host:' || p_host::text, 0));
  IF EXISTS (SELECT FROM public.appointment x
             WHERE x.host_staff_user_id = p_host AND x.id <> p_appointment_id
               AND x.status = 'scheduled' AND x.starts_at < p_ends_at
               AND p_starts_at < x.ends_at) THEN
    RAISE EXCEPTION 'host_overlap';
  END IF;
END $function$;

ALTER FUNCTION public.assert_host_free(uuid,uuid,timestamp with time zone,timestamp with time zone) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_host_free(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC;
