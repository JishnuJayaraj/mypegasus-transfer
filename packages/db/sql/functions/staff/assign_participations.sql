CREATE OR REPLACE FUNCTION public.assign_participations(p_project_id uuid, p_staff_user_id uuid, p_participation_ids uuid[], p_context public.audit_context)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_team_context(p_context);
  IF p_staff_user_id IS NULL OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT t.pid) FROM unnest(p_participation_ids) AS t(pid))
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF NOT public.is_project_lead(p_project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  -- Shared: no deactivation interleaves (it deletes the membership checked next).
  PERFORM FROM public.staff_user WHERE id = p_staff_user_id FOR SHARE;
  IF NOT EXISTS (
    SELECT FROM public.project_membership
    WHERE project_id = p_project_id AND staff_user_id = p_staff_user_id AND role = 'consultant') THEN
    RAISE EXCEPTION 'not_consultant';
  END IF;
  IF (SELECT count(*) FROM public.participation
      WHERE id = ANY (p_participation_ids) AND project_id = p_project_id)
     <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  FOR r IN
    INSERT INTO public.participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
    SELECT p_project_id, t.pid, p_staff_user_id, (p_context).staff_user_id
    FROM unnest(p_participation_ids) AS t(pid)
    WHERE NOT EXISTS (
      SELECT FROM public.participant_assignment a
      WHERE a.participation_id = t.pid AND a.staff_user_id = p_staff_user_id AND a.ended_at IS NULL)
    ORDER BY t.pid
    RETURNING participant_assignment.id, participant_assignment.participation_id
  LOOP
    PERFORM public.write_audit_event(p_project_id, r.participation_id, 'participant_assigned', p_context,
      NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'assignmentId', r.id), false);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

ALTER FUNCTION public.assign_participations(uuid,uuid,uuid[],public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assign_participations(uuid,uuid,uuid[],public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_participations(uuid,uuid,uuid[],public.audit_context) TO transfer_app;
