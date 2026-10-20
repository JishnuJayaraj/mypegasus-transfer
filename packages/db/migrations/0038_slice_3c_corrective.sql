ALTER TABLE "staff_audit_event" DROP CONSTRAINT "staff_audit_event_shape";--> statement-breakpoint
ALTER TABLE "staff_audit_event" ADD CONSTRAINT "staff_audit_event_shape" CHECK (coalesce(case
        when "staff_audit_event"."event_type"::text = 'staff_login_refused' then "staff_audit_event"."actor_staff_user_id" is null
          and "staff_audit_event"."reason_code" in ('unknown_account', 'account_deactivated', 'identity_mismatch')
          and ("staff_audit_event"."subject_staff_user_id" is null) = ("staff_audit_event"."reason_code" = 'unknown_account')
        when "staff_audit_event"."event_type"::text in ('staff_login', 'staff_logout', 'staff_identity_bound') then "staff_audit_event"."actor_staff_user_id" is not null
          and "staff_audit_event"."subject_staff_user_id" = "staff_audit_event"."actor_staff_user_id" and "staff_audit_event"."reason_code" is null
        when "staff_audit_event"."event_type"::text in ('region_created', 'region_changed') then "staff_audit_event"."actor_staff_user_id" is not null
          and "staff_audit_event"."subject_staff_user_id" is null and "staff_audit_event"."reason_code" is null
          and jsonb_typeof("staff_audit_event"."details" -> 'regionId') = 'string'
        when "staff_audit_event"."event_type"::text = 'org_role_revoked' then "staff_audit_event"."actor_staff_user_id" is not null
          and "staff_audit_event"."subject_staff_user_id" is not null
          and ("staff_audit_event"."reason_code" is null or "staff_audit_event"."reason_code" = 'account_deactivated')
        else "staff_audit_event"."actor_staff_user_id" is not null and "staff_audit_event"."subject_staff_user_id" is not null
          and "staff_audit_event"."reason_code" is null
      end, false));
--> statement-breakpoint

-- Admin survivorship (data-protection.md, regions and org roles): every operation that can remove
-- active admin authority takes this stable transaction lock before checking the actor. A waiting
-- operation sees the first one's committed role/deactivation and cannot let two admins remove
-- each other.
CREATE FUNCTION lock_admin_survivorship()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('staff:admin-survivorship', 0));
END $$;
--> statement-breakpoint

-- Replaced: admin survivorship is locked before the actor is checked. The lock is deliberately
-- also taken for regional-role revocations so deciding whether the row is an admin grant never
-- races the operation itself.
CREATE OR REPLACE FUNCTION revoke_org_role(
  p_staff_user_id uuid, p_role org_role, p_region_id uuid, p_actor uuid, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.lock_admin_survivorship();
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

-- The complete requested set is validated, then the target account is locked and its roles are
-- re-read before any difference is applied. Concurrent complete-set calls therefore finish as
-- one requested set or the other, never as a stale union/subtraction. The existing grant/revoke
-- functions keep the event format and stable refusal codes.
CREATE FUNCTION set_org_roles(
  p_staff_user_id uuid, p_roles org_role[], p_region_ids uuid[], p_actor uuid, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
  r record;
BEGIN
  PERFORM public.lock_admin_survivorship();
  PERFORM public.assert_global_admin(p_actor);
  IF p_staff_user_id IS NULL OR p_roles IS NULL OR p_region_ids IS NULL
     OR pg_catalog.cardinality(p_roles) <> pg_catalog.cardinality(p_region_ids)
     OR pg_catalog.cardinality(p_roles) > 20
     OR EXISTS (
       SELECT FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       WHERE w.role IS NULL OR (w.role = 'admin') IS DISTINCT FROM (w.region_id IS NULL))
     OR (SELECT count(*) FROM (
       SELECT w.role, w.region_id
       FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       GROUP BY w.role, w.region_id
     ) distinct_roles) <> pg_catalog.cardinality(p_roles) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF EXISTS (
    SELECT FROM ROWS FROM (
      pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
    ) AS w(role, region_id)
    WHERE w.region_id IS NOT NULL
      AND NOT EXISTS (SELECT FROM public.region WHERE id = w.region_id)) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  IF p_staff_user_id = p_actor
     AND EXISTS (SELECT FROM public.staff_org_role WHERE staff_user_id = p_actor AND role = 'admin')
     AND NOT EXISTS (
       SELECT FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       WHERE w.role = 'admin' AND w.region_id IS NULL) THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  FOR r IN
    SELECT held.role, held.region_id
    FROM public.staff_org_role held
    WHERE held.staff_user_id = p_staff_user_id AND NOT EXISTS (
      SELECT FROM ROWS FROM (
        pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
      ) AS w(role, region_id)
      WHERE w.role = held.role AND w.region_id IS NOT DISTINCT FROM held.region_id)
    ORDER BY held.role::text, held.region_id NULLS FIRST
  LOOP
    PERFORM public.revoke_org_role(
      p_staff_user_id, r.role, r.region_id, p_actor, p_request_id);
  END LOOP;
  FOR r IN
    SELECT w.role, w.region_id
    FROM ROWS FROM (
      pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
    ) AS w(role, region_id)
    WHERE NOT EXISTS (
      SELECT FROM public.staff_org_role held
      WHERE held.staff_user_id = p_staff_user_id AND held.role = w.role
        AND held.region_id IS NOT DISTINCT FROM w.region_id)
    ORDER BY w.role::text, w.region_id NULLS FIRST
  LOOP
    PERFORM public.grant_org_role(
      p_staff_user_id, r.role, r.region_id, p_actor, p_request_id);
  END LOOP;
END $$;
--> statement-breakpoint

-- Replaced: the survivorship lock and actor re-check come first. Org-role grants are removed in
-- the transaction too; one `org_role_revoked` event per grant preserves role, region and reason.
CREATE OR REPLACE FUNCTION deactivate_staff_user(p_id uuid, p_actor uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lock_admin_survivorship, set_org_roles FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_org_roles TO transfer_app;
