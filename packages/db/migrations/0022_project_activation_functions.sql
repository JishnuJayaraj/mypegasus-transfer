-- Hand-written (Slice 2 plan, sections 5.3 and 5.5; PR 2e-1; D9, R1, R26, Q98): project activation,
-- the draft gate in change_participation_status, and the grants. Same hardening as 0004, 0011,
-- 0016 and 0020: SECURITY DEFINER owned by transfer_owner, a fixed search_path with pg_temp last,
-- schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app, refusals as P0001 with a
-- stable code, never a value.

-- Draft → active (plan 5.5), one-way. The service decides on the snapshot under the lock first
-- (projectActivationBlockers); this re-checks the structure deterministically under the same
-- exclusive lock: a Project Agentur with a pinned template (Q76, Q90) and, in ta_tg, an entry
-- wave with a latest_entry_date (Q77). Agentur-submission blockers never block (Q91, Q92). The
-- instant and the actor come from the database and the context, never from a caller. The audit
-- event carries the Project Agentur, the version of its pinned template and the base-defaults
-- version (R26), computed here so the trail can't disagree with the row. Returns the event's id.
CREATE FUNCTION activate_project(
  p_id uuid, p_base_defaults_version integer, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project;
  v_version integer;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_base_defaults_version < 1, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'project_not_draft';
  END IF;
  SELECT version INTO v_version FROM public.project_template_pin
  WHERE project_id = p_id AND agentur_key = r.project_agentur_key ORDER BY seq DESC LIMIT 1;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'project_activation_blocked';
  END IF;
  IF r.type = 'ta_tg' AND NOT EXISTS (
    SELECT FROM public.project_entry_wave WHERE project_id = p_id AND latest_entry_date IS NOT NULL) THEN
    RAISE EXCEPTION 'no_entry_wave_with_latest_entry_date';
  END IF;
  UPDATE public.project
  SET status = 'active', activated_at = pg_catalog.now(), activated_by = (p_context).staff_user_id
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_activated', p_context, NULL, NULL, NULL, NULL,
    NULL, pg_catalog.jsonb_build_object('projectAgenturKey', r.project_agentur_key,
      'projectAgenturVersion', v_version, 'baseDefaultsVersion', p_base_defaults_version), false);
END $$;
--> statement-breakpoint

-- Replaced (defence in depth for the status service's draft gate): a status change of a project
-- that isn't active is refused (`project_not_active`). Otherwise as in 0007; same signature, so
-- owner, SECURITY DEFINER and the EXECUTE grant stay.
CREATE OR REPLACE FUNCTION change_participation_status(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_type public.project_type;
  v_track public.lifecycle_track;
  v_ending boolean := p_field = 'status' AND p_to IN ('withdrawn', 'exited');
  v_secondary public.end_reason[] := coalesce(p_secondary_reasons, '{}');
  v_signing_deadline date;
  v_event uuid;
  v_request public.profiling_exception_request;
  v_stale public.profiling_exception_superseded_reason;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system}');
  IF p_field IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (D9, R1, Q98): no transition of a draft project, manual or system. The shared
  -- project lock taken above serialises this with activate_project.
  IF (SELECT status FROM public.project WHERE id = r.project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF p_expected_from IS DISTINCT FROM (CASE p_field
       WHEN 'status' THEN r.status::text
       WHEN 'profiling_status' THEN r.profiling_status::text
       ELSE r.dsv_status::text END) THEN
    RAISE EXCEPTION 'stale_status';
  END IF;

  SELECT type INTO v_type FROM public.project WHERE id = r.project_id;
  SELECT * INTO v_request FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  v_track := CASE p_field WHEN 'status' THEN 'main' WHEN 'profiling_status' THEN 'profiling' ELSE 'dsv' END;
  IF NOT EXISTS (
    SELECT FROM public.lifecycle_edge e
    WHERE e.track = v_track AND e.from_value = p_expected_from AND e.to_value = p_to
      AND (p_context).actor_type = ANY (e.actors)
      AND (e.project_types IS NULL OR v_type = ANY (e.project_types))
      AND (CASE WHEN p_entry_kind IS NULL THEN e.kind IN ('manual', 'system') ELSE e.kind::text = p_entry_kind::text END)
  ) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  -- Track activity (plan 5.3): the tracks move while `informed` (DSV only in ta_tg); in the TG
  -- with an approved exception, profiling moves forward or is declined (Q74).
  IF v_track = 'dsv' AND NOT (r.status = 'informed' AND v_type = 'ta_tg')
     OR v_track = 'profiling' AND NOT (r.status = 'informed'
       OR r.status = 'active_in_tg' AND v_request.status IS NOT DISTINCT FROM 'approved' AND p_expected_from <> 'profiling_declined') THEN
    RAISE EXCEPTION 'track_inactive';
  END IF;

  IF v_ending THEN
    IF p_end_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required';
    END IF;
    IF NOT public.end_reason_fits(p_to::public.main_status, p_end_reason) THEN
      RAISE EXCEPTION 'reason_wrong_phase';
    END IF;
    -- Special category: not storable until encrypted storage exists (Q66).
    IF 'long_term_illness_reduced_earning_capacity' = ANY (p_end_reason || v_secondary) THEN
      RAISE EXCEPTION 'reason_not_storable';
    END IF;
    IF p_end_reason = ANY (v_secondary)
       OR pg_catalog.cardinality(v_secondary) <> (SELECT pg_catalog.count(DISTINCT s) FROM pg_catalog.unnest(v_secondary) s) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSIF p_end_reason IS NOT NULL OR pg_catalog.cardinality(v_secondary) > 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  -- Round 18: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (round 9), only they.
  IF (p_scheduled_at IS NULL) = coalesce(p_entry_kind IN ('scheduled_entry', 'scheduled_entry_catchup'), false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  IF p_to = 'dsv_offered' THEN
    IF r.entry_wave_id IS NULL THEN
      RAISE EXCEPTION 'wave_required';
    END IF;
    -- The first offer may use the wave's deadline, a re-offer needs its own (Q69); the system
    -- never invents one.
    SELECT signing_deadline INTO v_signing_deadline FROM public.project_entry_wave WHERE id = r.entry_wave_id;
    IF p_offer_deadline IS NULL AND (p_expected_from <> 'not_offered' OR v_signing_deadline IS NULL) THEN
      RAISE EXCEPTION 'offer_deadline_required';
    END IF;
  ELSIF p_offer_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  UPDATE public.participation SET
    status = CASE WHEN p_field = 'status' THEN p_to::public.main_status ELSE status END,
    profiling_status = CASE WHEN p_field = 'profiling_status' THEN p_to::public.profiling_status ELSE profiling_status END,
    dsv_status = CASE WHEN p_field = 'dsv_status' THEN p_to::public.dsv_status ELSE dsv_status END,
    tg_entry_date = CASE WHEN p_to = 'active_in_tg' THEN p_effective_date ELSE tg_entry_date END,
    exit_date = CASE WHEN p_to = 'exited' THEN p_effective_date ELSE exit_date END,
    withdrawn_on = CASE WHEN p_to = 'withdrawn' THEN p_effective_date ELSE withdrawn_on END,
    profiling_done_on = CASE WHEN p_to = 'profiling_done' THEN p_effective_date ELSE profiling_done_on END,
    end_reason = CASE WHEN v_ending THEN p_end_reason ELSE end_reason END,
    end_reason_source = CASE WHEN v_ending THEN (p_context).actor_type ELSE end_reason_source END,
    end_reason_secondary = CASE WHEN v_ending THEN v_secondary ELSE end_reason_secondary END,
    offer_deadline = CASE WHEN p_to = 'dsv_offered' THEN p_offer_deadline ELSE offer_deadline END,
    status_version = status_version + 1
  WHERE id = p_id
  RETURNING * INTO r;

  v_event := public.write_audit_event(r.project_id, p_id, 'status_changed', p_context, p_field,
    p_expected_from, p_to, p_end_reason::text, p_effective_date,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entryKind', p_entry_kind,
      'scheduledAt', pg_catalog.to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'secondaryReasons', CASE WHEN pg_catalog.cardinality(v_secondary) > 0 THEN pg_catalog.to_jsonb(v_secondary) END,
      'offerDeadline', p_offer_deadline)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies (round 10; system-only, round 12), as
  -- system with the same correlation ids (round 16).
  IF v_request.status IS NOT DISTINCT FROM 'requested' THEN
    v_stale := CASE
      WHEN r.status IN ('withdrawn', 'rejected', 'ta_completed', 'exited') THEN 'participation_closed'
      WHEN r.profiling_status IN ('profiling_done', 'profiling_declined') THEN 'profiling_closed'
    END;
    IF v_stale IS NOT NULL THEN
      UPDATE public.profiling_exception_request
      SET status = 'superseded', superseded_reason = v_stale
      WHERE id = v_request.id;
      PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_superseded',
        ROW('system', NULL, NULL, 'lifecycle.supersede-stale-exception', NULL,
            (p_context).request_id, (p_context).job_id)::public.audit_context,
        NULL, NULL, NULL, v_stale::text, NULL,
        pg_catalog.jsonb_build_object('profilingExceptionRequestId', v_request.id, 'statusChangeId', v_event), false);
    END IF;
  END IF;
  RETURN v_event;
END $$;
--> statement-breakpoint

-- Replaced: the activation event type is written only by its own function too (AC-40).
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
      'project_activated') THEN
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

-- Grants (plan 5.3): projects are activated only through activate_project.
REVOKE ALL ON FUNCTION activate_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION activate_project TO transfer_app;
