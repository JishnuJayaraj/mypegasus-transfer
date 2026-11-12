CREATE OR REPLACE FUNCTION public.remove_project_member(p_project_id uuid, p_staff_user_id uuid, p_role public.project_role, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_team_context(p_context);
  IF p_staff_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF NOT public.is_project_lead(p_project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  DELETE FROM public.project_membership
  WHERE project_id = p_project_id AND staff_user_id = p_staff_user_id AND role = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_not_found';
  END IF;
  IF p_role = 'project_lead' AND NOT EXISTS (
    SELECT FROM public.project_membership m JOIN public.staff_user s ON s.id = m.staff_user_id
    WHERE m.project_id = p_project_id AND m.role = 'project_lead' AND s.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'last_project_lead';
  END IF;
  IF p_role = 'consultant' THEN
    FOR r IN
      UPDATE public.participant_assignment
      SET ended_by = (p_context).staff_user_id, ended_at = now(), end_reason = 'consultant_removed'
      WHERE project_id = p_project_id AND staff_user_id = p_staff_user_id AND ended_at IS NULL
      RETURNING id, participation_id
    LOOP
      PERFORM public.write_audit_event(p_project_id, r.participation_id, 'participant_unassigned',
        p_context, NULL, NULL, NULL, 'consultant_removed', NULL,
        pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'assignmentId', r.id), false);
    END LOOP;
  END IF;
  PERFORM public.write_audit_event(p_project_id, NULL, 'project_member_removed', p_context, NULL, NULL,
    NULL, 'member_removed', NULL,
    pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'role', p_role), false);
END $function$;

ALTER FUNCTION public.remove_project_member(uuid,uuid,public.project_role,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.remove_project_member(uuid,uuid,public.project_role,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_project_member(uuid,uuid,public.project_role,public.audit_context) TO transfer_app;
