CREATE OR REPLACE FUNCTION public.deactivate_staff_user(p_id uuid, p_actor uuid, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
  v_context public.audit_context := ROW('user', p_actor, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context;
  v_sessions integer;
  v_memberships integer := 0;
  v_assignments integer := 0;
  v_org_roles integer := 0;
  r record;
BEGIN
  PERFORM public.lock_admin_survivorship();
  PERFORM public.assert_global_admin(p_actor);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_id = p_actor THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  -- The project locks first after the global survivorship lock (order: admin → project → account).
  PERFORM public.lock_projects_of_staff(p_id);
  SELECT * INTO u FROM public.staff_user WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  PERFORM public.lock_projects_of_staff(p_id);
  IF EXISTS (
    SELECT FROM public.project_membership m
    WHERE m.staff_user_id = p_id AND m.role = 'project_lead'
      AND NOT EXISTS (
        SELECT FROM public.project_membership o JOIN public.staff_user s ON s.id = o.staff_user_id
        WHERE o.project_id = m.project_id AND o.role = 'project_lead' AND o.staff_user_id <> p_id
          AND s.deactivated_at IS NULL)) THEN
    RAISE EXCEPTION 'last_project_lead';
  END IF;
  UPDATE public.staff_session SET ended_at = now(), end_reason = 'deactivated'
  WHERE staff_user_id = p_id AND ended_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  FOR r IN
    UPDATE public.participant_assignment
    SET ended_by = p_actor, ended_at = now(), end_reason = 'account_deactivated'
    WHERE staff_user_id = p_id AND ended_at IS NULL
    RETURNING id, project_id, participation_id
  LOOP
    PERFORM public.write_audit_event(r.project_id, r.participation_id, 'participant_unassigned', v_context,
      NULL, NULL, NULL, 'account_deactivated', NULL,
      pg_catalog.jsonb_build_object('staffUserId', p_id, 'assignmentId', r.id), false);
    v_assignments := v_assignments + 1;
  END LOOP;
  FOR r IN
    DELETE FROM public.project_membership WHERE staff_user_id = p_id RETURNING project_id, role
  LOOP
    PERFORM public.write_audit_event(r.project_id, NULL, 'project_member_removed', v_context,
      NULL, NULL, NULL, 'account_deactivated', NULL,
      pg_catalog.jsonb_build_object('staffUserId', p_id, 'role', r.role), false);
    v_memberships := v_memberships + 1;
  END LOOP;
  FOR r IN
    DELETE FROM public.staff_org_role WHERE staff_user_id = p_id RETURNING role, region_id
  LOOP
    INSERT INTO public.staff_audit_event (
      event_type, actor_staff_user_id, subject_staff_user_id, reason_code, details, request_id)
    VALUES ('org_role_revoked', p_actor, p_id, 'account_deactivated',
      pg_catalog.jsonb_build_object('role', r.role, 'regionId', r.region_id), p_request_id);
    v_org_roles := v_org_roles + 1;
  END LOOP;
  UPDATE public.staff_user SET deactivated_at = now() WHERE id = p_id;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_deactivated', p_actor, p_id, pg_catalog.jsonb_build_object(
    'endedSessions', v_sessions, 'removedMemberships', v_memberships,
    'endedAssignments', v_assignments, 'removedOrgRoles', v_org_roles), p_request_id);
END $function$;

ALTER FUNCTION public.deactivate_staff_user(uuid,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.deactivate_staff_user(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_staff_user(uuid,uuid,text) TO transfer_app;
