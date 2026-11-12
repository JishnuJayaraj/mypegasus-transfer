CREATE OR REPLACE FUNCTION public.lock_project_setup(p_project_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
END $function$;

ALTER FUNCTION public.lock_project_setup(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_project_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_project_setup(uuid) TO transfer_app;
