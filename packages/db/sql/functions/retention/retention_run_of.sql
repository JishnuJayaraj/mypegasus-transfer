CREATE OR REPLACE FUNCTION public.retention_run_of(p_run uuid)
 RETURNS public.retention_run
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run;
BEGIN
  IF session_user <> 'transfer_retention' THEN RAISE EXCEPTION 'retention_role_required'; END IF;
  IF NOT public.in_retention_run()
     OR pg_catalog.current_setting('transfer.retention_run', true) <> p_run::text THEN
    RAISE EXCEPTION 'run_not_open';
  END IF;
  SELECT * INTO r FROM public.retention_run WHERE id = p_run;
  RETURN r;
END $function$;

ALTER FUNCTION public.retention_run_of(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_run_of(uuid) FROM PUBLIC;
