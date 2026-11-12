CREATE OR REPLACE FUNCTION public.unassign_participation(p_participation_id uuid, p_staff_user_id uuid, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project_id uuid;
  v_id uuid;
BEGIN
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project_id);
  PERFORM public.assert_team_context(p_context);
  IF NOT public.is_project_lead(v_project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  UPDATE public.participant_assignment
  SET ended_by = (p_context).staff_user_id, ended_at = now(), end_reason = 'unassigned'
  WHERE participation_id = p_participation_id AND staff_user_id = p_staff_user_id AND ended_at IS NULL
  RETURNING id INTO v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment_not_found';
  END IF;
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'participant_unassigned', p_context,
    NULL, NULL, NULL, 'unassigned', NULL,
    pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'assignmentId', v_id), false);
END $function$;

ALTER FUNCTION public.unassign_participation(uuid,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.unassign_participation(uuid,uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unassign_participation(uuid,uuid,public.audit_context) TO transfer_app;
