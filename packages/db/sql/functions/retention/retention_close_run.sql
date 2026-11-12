CREATE OR REPLACE FUNCTION public.retention_close_run(p_run uuid, p_summary jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  IF pg_catalog.jsonb_typeof(p_summary) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  UPDATE public.retention_run SET closed_at = pg_catalog.now(), summary = p_summary WHERE id = p_run;
  PERFORM pg_catalog.set_config('transfer.retention_run', '', true);
END $function$;

ALTER FUNCTION public.retention_close_run(uuid,jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_close_run(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_close_run(uuid,jsonb) TO transfer_retention;
