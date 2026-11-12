CREATE OR REPLACE FUNCTION public.retention_lock_erasure_projects(p_run uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_project uuid;
BEGIN
  PERFORM public.retention_run_of(p_run);
  FOR v_project IN SELECT DISTINCT project_id FROM public.participation
    WHERE status::text IN ('withdrawn','ta_completed','exited') ORDER BY project_id LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project));
  END LOOP;
END $function$;

ALTER FUNCTION public.retention_lock_erasure_projects(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_lock_erasure_projects(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_lock_erasure_projects(uuid) TO transfer_retention;
