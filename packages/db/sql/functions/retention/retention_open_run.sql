CREATE OR REPLACE FUNCTION public.retention_open_run(p_run_day date, p_dry_run boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF session_user <> 'transfer_retention' THEN RAISE EXCEPTION 'retention_role_required'; END IF;
  IF p_run_day IS NULL OR p_dry_run IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF p_run_day > (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date THEN
    RAISE EXCEPTION 'run_not_due';
  END IF;
  IF coalesce(pg_catalog.current_setting('transfer.retention_run', true), '') <> '' THEN
    RAISE EXCEPTION 'run_open';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('retention_run'));
  INSERT INTO public.retention_run (id, run_day, dry_run, opened_txid)
  VALUES (v_id, p_run_day, p_dry_run, pg_catalog.txid_current());
  PERFORM pg_catalog.set_config('transfer.retention_run', v_id::text, true);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.retention_open_run(date,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_open_run(date,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_open_run(date,boolean) TO transfer_retention;
