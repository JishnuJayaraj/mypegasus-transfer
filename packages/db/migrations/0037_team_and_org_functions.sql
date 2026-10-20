-- Hand-written (Slice 3, PR 3c; Q62, Q126): regions, staff accounts, org roles, project
-- memberships and participant assignments, and their grants. Same hardening as 0004: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, refusals as P0001 with a stable code, never a
-- value. Each function writes its audit events in the caller's transaction: account, org-role and
-- region changes to `staff_audit_event` (they have no project), team and assignment changes to
-- `audit_event`. Names and emails never enter either trail. Times are database time.

-- The global admin (Q126): an active account holding `admin`, which is never region-scoped.
-- Internal, no EXECUTE for transfer_app.
CREATE FUNCTION assert_global_admin(p_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT FROM public.staff_org_role r JOIN public.staff_user u ON u.id = r.staff_user_id
    WHERE r.staff_user_id = p_actor AND r.role = 'admin' AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
END $$;
--> statement-breakpoint

-- Whether the staff user holds `project_lead` in the project (memberships of deactivated accounts
-- are deleted with the deactivation, so a member is active). Internal.
CREATE FUNCTION is_project_lead(p_project_id uuid, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM public.project_membership m JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = p_project_id AND m.staff_user_id = p_staff_user_id
      AND m.role = 'project_lead' AND u.deactivated_at IS NULL)
$$;
--> statement-breakpoint

-- The project events of a team change are the acting staff user's, never in assisted mode.
-- Internal.
CREATE FUNCTION assert_team_context(p_context audit_context)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
END $$;
--> statement-breakpoint

-- Text of names (accounts, regions): trimmed, 1–100 characters, no control characters.
CREATE FUNCTION staff_text_valid(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL AND p_value = pg_catalog.btrim(p_value)
    AND pg_catalog.length(p_value) BETWEEN 1 AND 100 AND p_value !~ '[[:cntrl:]]'
$$;
--> statement-breakpoint

CREATE FUNCTION region_code_valid(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL AND p_value ~ '^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])?$'
$$;
--> statement-breakpoint

CREATE FUNCTION staff_email_valid(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL AND p_value ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
    AND pg_catalog.length(p_value) <= 254
$$;
--> statement-breakpoint

-- A region (Q35, Q126), by the global admin; `region_created` names its id, never its name.
CREATE FUNCTION create_region(
  p_code text, p_name text, p_actor uuid, p_request_id text, p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF NOT public.region_code_valid(p_code) OR NOT public.staff_text_valid(p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  BEGIN
    INSERT INTO public.region (id, code, name) VALUES (v_id, p_code, p_name);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'region_code_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, details, request_id)
  VALUES ('region_created', p_actor, pg_catalog.jsonb_build_object('regionId', v_id), p_request_id);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Code or name (null = unchanged); a change to the current values is refused without a write.
CREATE FUNCTION update_region(
  p_id uuid, p_actor uuid, p_request_id text, p_code text DEFAULT NULL, p_name text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.region;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_code IS NOT NULL AND NOT public.region_code_valid(p_code)
     OR p_name IS NOT NULL AND NOT public.staff_text_valid(p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.region WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  IF p_code IS NOT NULL AND p_code <> r.code THEN
    v_fields := pg_catalog.array_append(v_fields, 'code');
  END IF;
  IF p_name IS NOT NULL AND p_name <> r.name THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'region_unchanged';
  END IF;
  BEGIN
    UPDATE public.region SET code = coalesce(p_code, code), name = coalesce(p_name, name)
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'region_code_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, details, request_id)
  VALUES ('region_changed', p_actor,
    pg_catalog.jsonb_build_object('regionId', p_id, 'fields', pg_catalog.to_jsonb(v_fields)), p_request_id);
END $$;
--> statement-breakpoint

-- A staff account (Q7, Q126), by the global admin. One account per address, compared
-- case-insensitively (`email_taken`). `staff_account_created` records the flag, never name or
-- email.
CREATE FUNCTION create_staff_user(
  p_display_name text, p_email text, p_may_create_projects boolean, p_actor uuid, p_request_id text,
  p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF NOT public.staff_text_valid(p_display_name) OR NOT public.staff_email_valid(p_email)
     OR p_may_create_projects IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  BEGIN
    INSERT INTO public.staff_user (id, display_name, email, may_create_projects)
    VALUES (v_id, p_display_name, p_email, p_may_create_projects);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'email_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_created', p_actor, v_id,
    pg_catalog.jsonb_build_object('mayCreateProjects', p_may_create_projects), p_request_id);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Name, email or the project-creation flag of an active account (null = unchanged).
-- `staff_account_changed` lists the changed keys and the flag's new value, never name or email.
CREATE FUNCTION update_staff_user(
  p_id uuid, p_actor uuid, p_request_id text, p_display_name text DEFAULT NULL,
  p_email text DEFAULT NULL, p_may_create_projects boolean DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_display_name IS NOT NULL AND NOT public.staff_text_valid(p_display_name)
     OR p_email IS NOT NULL AND NOT public.staff_email_valid(p_email) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_display_name IS NOT NULL AND p_display_name <> u.display_name THEN
    v_fields := pg_catalog.array_append(v_fields, 'displayName');
  END IF;
  IF p_email IS NOT NULL AND p_email <> u.email THEN
    v_fields := pg_catalog.array_append(v_fields, 'email');
  END IF;
  IF p_may_create_projects IS NOT NULL AND p_may_create_projects <> u.may_create_projects THEN
    v_fields := pg_catalog.array_append(v_fields, 'mayCreateProjects');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'staff_user_unchanged';
  END IF;
  BEGIN
    UPDATE public.staff_user
    SET display_name = coalesce(p_display_name, display_name), email = coalesce(p_email, email),
        may_create_projects = coalesce(p_may_create_projects, may_create_projects)
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'email_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_changed', p_actor, p_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'mayCreateProjects', CASE WHEN 'mayCreateProjects' = ANY (v_fields) THEN p_may_create_projects END)),
    p_request_id);
END $$;
--> statement-breakpoint

-- The projects a staff user is a member of or assigned in, locked exclusively in id order.
-- Internal.
CREATE FUNCTION lock_projects_of_staff(p_staff_user_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Deactivation (Q59, Q126), by the global admin, never of their own account. Refused while the
-- account is the last active PL of a project (`last_project_lead`). In one transaction it ends the
-- account's live sessions (`deactivated`), closes its open assignments and deletes its memberships,
-- each with its project event, sets `deactivated_at` and writes `staff_account_deactivated` with
-- the counts. The account itself stays (never deleted).
CREATE FUNCTION deactivate_staff_user(p_id uuid, p_actor uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
  v_context public.audit_context := ROW('user', p_actor, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context;
  v_sessions integer;
  v_memberships integer := 0;
  v_assignments integer := 0;
  r record;
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_id = p_actor THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  -- The project locks first (order: project → account row), like the team functions.
  PERFORM public.lock_projects_of_staff(p_id);
  -- For update: no session starts (FOR SHARE) and no membership or assignment is added (they lock
  -- the account FOR SHARE) until this commits.
  SELECT * INTO u FROM public.staff_user WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  -- Whatever was added before the row lock (re-entrant for the projects locked above).
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
  UPDATE public.staff_user SET deactivated_at = now() WHERE id = p_id;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_deactivated', p_actor, p_id, pg_catalog.jsonb_build_object(
    'endedSessions', v_sessions, 'removedMemberships', v_memberships, 'endedAssignments', v_assignments),
    p_request_id);
END $$;
--> statement-breakpoint

-- An org role (Q80, Q126), by the global admin: `admin` global, the regional roles for one
-- region. Only for an active account; a role it holds is refused (`org_role_exists`).
CREATE FUNCTION grant_org_role(
  p_staff_user_id uuid, p_role org_role, p_region_id uuid, p_actor uuid, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_role IS NULL OR (p_role = 'admin') <> (p_region_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_region_id IS NOT NULL AND NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  INSERT INTO public.staff_org_role (staff_user_id, role, region_id, granted_by)
  VALUES (p_staff_user_id, p_role, p_region_id, p_actor)
  ON CONFLICT ON CONSTRAINT staff_org_role_unique DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_role_exists';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('org_role_granted', p_actor, p_staff_user_id,
    pg_catalog.jsonb_build_object('role', p_role, 'regionId', p_region_id), p_request_id);
END $$;
--> statement-breakpoint

-- Revokes an org role (the row goes, `org_role_revoked` stays). The global admin never revokes
-- their own admin role (`own_account`), so the last admin can't lock everyone out by accident.
CREATE FUNCTION revoke_org_role(
  p_staff_user_id uuid, p_role org_role, p_region_id uuid, p_actor uuid, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_role IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_staff_user_id = p_actor AND p_role = 'admin' THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  PERFORM FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  DELETE FROM public.staff_org_role
  WHERE staff_user_id = p_staff_user_id AND role = p_role AND region_id IS NOT DISTINCT FROM p_region_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_role_not_found';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('org_role_revoked', p_actor, p_staff_user_id,
    pg_catalog.jsonb_build_object('role', p_role, 'regionId', p_region_id), p_request_id);
END $$;
--> statement-breakpoint

-- A project role for a staff member (Q61, Q126) under the exclusive project lock. The project's
-- PL adds any role; a global admin only a replacement PL other than themselves (recovery; no case
-- access follows from it). Regional admins manage no team. Only active accounts.
CREATE FUNCTION add_project_member(
  p_project_id uuid, p_staff_user_id uuid, p_role project_role, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid := (p_context).staff_user_id;
  u public.staff_user;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_team_context(p_context);
  IF p_staff_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF NOT public.is_project_lead(p_project_id, v_actor) THEN
    IF p_role <> 'project_lead' THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    PERFORM public.assert_global_admin(v_actor);
    IF p_staff_user_id = v_actor THEN
      RAISE EXCEPTION 'own_account';
    END IF;
  END IF;
  -- Shared: a deactivation of the account (FOR UPDATE) never interleaves.
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  INSERT INTO public.project_membership (project_id, staff_user_id, role)
  VALUES (p_project_id, p_staff_user_id, p_role) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_exists';
  END IF;
  PERFORM public.write_audit_event(p_project_id, NULL, 'project_member_added', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'role', p_role), false);
END $$;
--> statement-breakpoint

-- Removes a project role, by the project's PL, under the exclusive project lock. The last active
-- PL stays (`last_project_lead`). Removing `consultant` closes that person's open assignments in
-- the project (`consultant_removed`), each with its event.
CREATE FUNCTION remove_project_member(
  p_project_id uuid, p_staff_user_id uuid, p_role project_role, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Assigns participations of the project to a member holding `consultant` (Q62), by the PL, under
-- the exclusive project lock; all or nothing. One to 500 distinct participations; one already
-- assigned to that consultant is left as it is. Returns the number of new assignments, each with
-- its `participant_assigned`.
CREATE FUNCTION assign_participations(
  p_project_id uuid, p_staff_user_id uuid, p_participation_ids uuid[], p_context audit_context
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Closes a consultant's open assignment of a participation (`unassigned`), by the PL, under the
-- exclusive project lock. Access ends with it: the API loads open assignments per request.
CREATE FUNCTION unassign_participation(
  p_participation_id uuid, p_staff_user_id uuid, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Replaced with a region (Q126): staff whose `may_create_projects` is set create projects, in a
-- region they choose (`region_required`, `region_not_found`); the creator becomes the PL.
DROP FUNCTION create_project(text, text, project_type, audit_context, uuid);
--> statement-breakpoint
CREATE FUNCTION create_project(
  p_name text, p_customer_name text, p_type project_type, p_context audit_context, p_id uuid DEFAULT NULL,
  p_region_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_staff uuid := (p_context).staff_user_id;
BEGIN
  -- The new project's exclusive lock first, like every setup mutation (D3, round 23).
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_id));
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.staff_user
      WHERE id = v_staff AND may_create_projects AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p_type IS NULL OR NOT public.project_text_valid(p_name) OR NOT public.project_text_valid(p_customer_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_region_id IS NULL THEN
    RAISE EXCEPTION 'region_required';
  END IF;
  IF NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  INSERT INTO public.project (id, name, customer_name, type, created_by, region_id)
  VALUES (v_id, p_name, p_customer_name, p_type, v_staff, p_region_id);
  INSERT INTO public.project_membership (project_id, staff_user_id, role)
  VALUES (v_id, v_staff, 'project_lead');
  PERFORM public.write_audit_event(v_id, NULL, 'project_created', p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('type', p_type), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Replaced with a region (Q126): the PL changes it while draft, a global admin at any time
-- (`project_not_draft` for anyone else after activation); never back to none. The service checks
-- who may change what; this re-checks the state.
DROP FUNCTION update_project(uuid, audit_context, text, text, project_type, text);
--> statement-breakpoint
CREATE FUNCTION update_project(
  p_id uuid, p_context audit_context, p_name text DEFAULT NULL, p_customer_name text DEFAULT NULL,
  p_type project_type DEFAULT NULL, p_project_agentur_key text DEFAULT NULL, p_region_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project;
  v_fields text[] := '{}';
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  IF p_name IS NOT NULL AND NOT public.project_text_valid(p_name)
     OR p_customer_name IS NOT NULL AND NOT public.project_text_valid(p_customer_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_name IS DISTINCT FROM r.name AND p_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF p_customer_name IS DISTINCT FROM r.customer_name AND p_customer_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'customerName');
  END IF;
  IF p_type IS DISTINCT FROM r.type AND p_type IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF EXISTS (SELECT FROM public.participation WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_participations';
    ELSIF EXISTS (SELECT FROM public.project_entry_wave WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_waves';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'type');
  END IF;
  IF p_project_agentur_key IS DISTINCT FROM r.project_agentur_key AND p_project_agentur_key IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF NOT EXISTS (SELECT FROM public.project_template_pin
                      WHERE project_id = p_id AND agentur_key = p_project_agentur_key) THEN
      RAISE EXCEPTION 'agentur_not_pinned';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'projectAgenturKey');
  END IF;
  IF p_region_id IS DISTINCT FROM r.region_id AND p_region_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
      RAISE EXCEPTION 'region_not_found';
    END IF;
    IF r.status <> 'draft' AND NOT EXISTS (
        SELECT FROM public.staff_org_role WHERE staff_user_id = (p_context).staff_user_id AND role = 'admin') THEN
      RAISE EXCEPTION 'project_not_draft';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'regionId');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'project_unchanged';
  END IF;
  UPDATE public.project
  SET name = coalesce(p_name, name), customer_name = coalesce(p_customer_name, customer_name),
      type = coalesce(p_type, type),
      project_agentur_key = coalesce(p_project_agentur_key, project_agentur_key),
      region_id = coalesce(p_region_id, region_id)
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_changed', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'type', CASE WHEN 'type' = ANY (v_fields) THEN p_type END,
      'projectAgenturKey', CASE WHEN 'projectAgenturKey' = ANY (v_fields) THEN p_project_agentur_key END,
      'regionId', CASE WHEN 'regionId' = ANY (v_fields) THEN p_region_id END)),
    false);
END $$;
--> statement-breakpoint

-- Replaced: the team and assignment event types are written only by their own functions too.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed',
      'config_template_pinned', 'config_override_changed', 'rule_relaxation_requested',
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn',
      'project_activated', 'participant_data_changed', 'participation_dates_changed',
      'project_member_added', 'project_member_removed', 'participant_assigned',
      'participant_unassigned') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context, NULL, NULL,
    NULL, p_reason_code, p_effective_date, p_details, coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION assert_global_admin, is_project_lead, assert_team_context, staff_text_valid,
  region_code_valid, staff_email_valid, lock_projects_of_staff, create_region, update_region,
  create_staff_user, update_staff_user, deactivate_staff_user, grant_org_role, revoke_org_role,
  add_project_member, remove_project_member, assign_participations, unassign_participation,
  create_project, update_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_region, update_region, create_staff_user, update_staff_user,
  deactivate_staff_user, grant_org_role, revoke_org_role, add_project_member, remove_project_member,
  assign_participations, unassign_participation, create_project, update_project TO transfer_app;
--> statement-breakpoint
-- Reads only; every write is a function's.
GRANT SELECT ON TABLE region, staff_org_role, participant_assignment TO transfer_app;
