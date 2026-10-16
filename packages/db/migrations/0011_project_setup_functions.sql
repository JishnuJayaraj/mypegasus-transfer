-- Hand-written (Slice 2 plan, sections 5.2 and 5.3; PR 2a; round 22): the project lock, project
-- creation and editing, and their grants. Same hardening as 0004: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, refusals as P0001 with a stable code, never a value.

-- Projects created with the Slice 0 form after migration 0003 kept their contractual dates only on
-- the project row. Copy them into a wave W1 (as 0003 did) before 0012 drops the columns (AC-3).
INSERT INTO public.project_entry_wave (project_id, code, name, signing_deadline, default_tg_start, default_tg_end)
SELECT p.id, 'W1', 'W1', p.signing_deadline, p.default_tg_start, p.default_tg_end
FROM public.project p
WHERE p.type = 'ta_tg'
  AND (p.signing_deadline IS NOT NULL OR p.default_tg_start IS NOT NULL OR p.default_tg_end IS NOT NULL)
  AND NOT EXISTS (SELECT FROM public.project_entry_wave w WHERE w.project_id = p.id);
--> statement-breakpoint

-- Every existing project gets its PL member (D4, round 23): the creator, when their flat role is
-- project_lead (the only role that may create a project, Q106). Nobody else is elevated: a
-- project left without a PL member fails the migration, to be resolved by hand.
INSERT INTO public.project_membership (project_id, staff_user_id, role)
SELECT p.id, p.created_by, 'project_lead'
FROM public.project p
JOIN public.staff_user s ON s.id = p.created_by AND s.role = 'project_lead'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM public.project p
    WHERE NOT EXISTS (
      SELECT FROM public.project_membership m WHERE m.project_id = p.id AND m.role = 'project_lead')
  ) THEN
    RAISE EXCEPTION 'project_without_project_lead';
  END IF;
END $$;
--> statement-breakpoint

-- The project lock (D3, round 22): a transaction-scoped advisory lock per project, acquired inside
-- the functions, never left to a service. Setup mutations take it exclusively; everything that
-- locks or creates a participation takes it shared first. Order everywhere: project → template
-- version → participation row. A hash collision only serialises two projects more than needed.
CREATE FUNCTION project_lock_key(p_project_id uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.hashtextextended('project:' || p_project_id::text, 0)
$$;
--> statement-breakpoint

-- Exclusive; for every setup mutation, and for a service that must read and decide under the lock
-- before it writes (activation, migration, the import confirm). Re-entrant within a transaction.
CREATE FUNCTION lock_project_setup(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
END $$;
--> statement-breakpoint

-- Replaced: the shared project lock before the row lock. Every participation function locks
-- through this, so none can interleave with a setup mutation of its project.
CREATE OR REPLACE FUNCTION lock_participation(p_id uuid)
RETURNS participation LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Replaced: the creation edge takes the shared project lock first (round 22).
CREATE OR REPLACE FUNCTION create_participation(
  p_project_id uuid, p_context audit_context, p_entry_wave_id uuid DEFAULT NULL, p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_type public.project_type;
BEGIN
  PERFORM public.assert_context(p_context, v_id, (
    SELECT actors FROM public.lifecycle_edge
    WHERE track = 'main' AND from_value IS NULL AND to_value = 'imported' AND kind = 'manual'));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.project_lock_key(p_project_id));
  SELECT type INTO v_type FROM public.project WHERE id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF p_entry_wave_id IS NOT NULL THEN
    IF v_type <> 'ta_tg' THEN
      RAISE EXCEPTION 'not_ta_tg';
    END IF;
    IF NOT EXISTS (SELECT FROM public.project_entry_wave WHERE id = p_entry_wave_id AND project_id = p_project_id) THEN
      RAISE EXCEPTION 'wave_of_other_project';
    END IF;
  END IF;
  INSERT INTO public.participation (id, project_id, entry_wave_id, status, profiling_status, dsv_status)
  VALUES (v_id, p_project_id, p_entry_wave_id, 'imported', 'not_started', 'not_offered');
  PERFORM public.write_audit_event(p_project_id, v_id, 'participation_created', p_context, 'status', NULL,
    'imported', NULL, NULL, jsonb_strip_nulls(jsonb_build_object('entryWaveId', p_entry_wave_id)), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- A project's name or customer: trimmed, 1–200 characters (the domain's CreateProjectInput).
CREATE FUNCTION project_text_valid(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL AND p_value = pg_catalog.btrim(p_value) AND pg_catalog.length(p_value) BETWEEN 1 AND 200
$$;
--> statement-breakpoint

-- A project and its creator's PL membership (Q106: until Slice 3 only staff with the flat role
-- project_lead create projects). Name and customer never enter the audit trail. Returns its id.
CREATE FUNCTION create_project(
  p_name text, p_customer_name text, p_type project_type, p_context audit_context, p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_staff uuid := (p_context).staff_user_id;
BEGIN
  -- The new project's exclusive lock first, like every setup mutation (D3, round 23).
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_id));
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT EXISTS (SELECT FROM public.staff_user WHERE id = v_staff AND role = 'project_lead') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p_type IS NULL OR NOT public.project_text_valid(p_name) OR NOT public.project_text_valid(p_customer_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.project (id, name, customer_name, type, created_by)
  VALUES (v_id, p_name, p_customer_name, p_type, v_staff);
  INSERT INTO public.project_membership (project_id, staff_user_id, role)
  VALUES (v_id, v_staff, 'project_lead');
  PERFORM public.write_audit_event(v_id, NULL, 'project_created', p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('type', p_type), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Changes name, customer or type (null = unchanged) under the exclusive project lock. The type
-- changes only while draft and without participations or waves (Q98, round 22); a change to the
-- current values is refused without a write (`project_unchanged`). The audit event lists the
-- changed keys, never the free text. Returns the event's id.
CREATE FUNCTION update_project(
  p_id uuid, p_context audit_context, p_name text DEFAULT NULL, p_customer_name text DEFAULT NULL,
  p_type project_type DEFAULT NULL
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
    v_fields := array_append(v_fields, 'name');
  END IF;
  IF p_customer_name IS DISTINCT FROM r.customer_name AND p_customer_name IS NOT NULL THEN
    v_fields := array_append(v_fields, 'customerName');
  END IF;
  IF p_type IS DISTINCT FROM r.type AND p_type IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF EXISTS (SELECT FROM public.participation WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_participations';
    ELSIF EXISTS (SELECT FROM public.project_entry_wave WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_waves';
    END IF;
    v_fields := array_append(v_fields, 'type');
  END IF;
  IF cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'project_unchanged';
  END IF;
  UPDATE public.project
  SET name = coalesce(p_name, name), customer_name = coalesce(p_customer_name, customer_name),
      type = coalesce(p_type, type)
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_changed', p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object('fields', to_jsonb(v_fields),
      'type', CASE WHEN 'type' = ANY (v_fields) THEN p_type END)), false);
END $$;
--> statement-breakpoint

-- Replaced: the setup event types are written only by their own functions too.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed') THEN
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

-- Grants (plan 5.3): projects are written only through the functions above; memberships are read
-- by the API to build the access subject.
REVOKE INSERT ON TABLE project FROM transfer_app;
--> statement-breakpoint
GRANT SELECT ON TABLE project_membership TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION project_lock_key, project_text_valid, lock_project_setup, create_project,
  update_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lock_project_setup, create_project, update_project TO transfer_app;
