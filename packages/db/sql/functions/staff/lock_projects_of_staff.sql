CREATE OR REPLACE FUNCTION public.lock_projects_of_staff(p_staff_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project uuid;
BEGIN
  FOR v_project IN
    SELECT project_id FROM public.project_membership WHERE staff_user_id = p_staff_user_id
    UNION
    SELECT project_id FROM public.participant_assignment
    WHERE staff_user_id = p_staff_user_id AND ended_at IS NULL
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project));
  END LOOP;
END $function$;

ALTER FUNCTION public.lock_projects_of_staff(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_projects_of_staff(uuid) FROM PUBLIC;
