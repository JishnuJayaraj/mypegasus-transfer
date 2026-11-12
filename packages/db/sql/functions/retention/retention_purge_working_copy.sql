CREATE OR REPLACE FUNCTION public.retention_purge_working_copy(p_run uuid, p_document_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
BEGIN
  IF NOT public.retention_lock_working_copy(p_run, p_document_id) OR r.dry_run THEN RETURN false; END IF;
  UPDATE public.document SET deleted_at = pg_catalog.now(), deleted_by = 'system', file_name = NULL,
    purged_at = pg_catalog.now() WHERE id = p_document_id;
  RETURN FOUND;
END $function$;

ALTER FUNCTION public.retention_purge_working_copy(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_purge_working_copy(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_purge_working_copy(uuid,uuid) TO transfer_retention;
