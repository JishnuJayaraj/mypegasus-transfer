CREATE OR REPLACE FUNCTION public.in_retention_run()
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v text := pg_catalog.current_setting('transfer.retention_run', true);
BEGIN
  IF session_user <> 'transfer_retention' OR v IS NULL
     OR v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT FROM public.retention_run WHERE id = v::uuid AND closed_at IS NULL
    AND opened_txid = pg_catalog.txid_current());
END $function$;

ALTER FUNCTION public.in_retention_run() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.in_retention_run() FROM PUBLIC;
