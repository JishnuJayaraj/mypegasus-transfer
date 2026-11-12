CREATE OR REPLACE FUNCTION public.lock_participation(p_id uuid)
 RETURNS public.participation
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_project_id uuid;
BEGIN
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.project_lock_key(v_project_id));
  SELECT * INTO r FROM public.participation WHERE id = p_id FOR UPDATE;
  RETURN r;
END $function$;

ALTER FUNCTION public.lock_participation(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_participation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_participation(uuid) TO transfer_app;
