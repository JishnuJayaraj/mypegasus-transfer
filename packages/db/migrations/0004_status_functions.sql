-- Hand-written: the status functions and their grants (Slice 1 plan, sections 5.4 and 5.10; D2;
-- ADR-0002). Only these functions write participation statuses and audit events. Each one is
-- SECURITY DEFINER (owner transfer_owner, who runs the migrations), has a fixed search_path with
-- pg_temp last (so a caller's temporary table can't shadow ours), uses no dynamic SQL, and is
-- executable only by transfer_app. Errors are SQLSTATE P0001 with a stable code as the message,
-- never a value. Lifecycle guards live in TypeScript; these check the edge list, the invariants
-- and the four-eyes rule.

-- New functions in public are not executable by PUBLIC; the grants below are explicit.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- Who acts, and the request/job correlation, passed to every function and copied into the audit
-- row. Consistency (user ⇒ staff id, …) is the audit_event CHECK.
CREATE TYPE audit_context AS (
  actor_type actor_type,
  staff_user_id uuid,
  participation_id uuid,
  system_job text,
  on_behalf_of uuid,
  request_id text,
  job_id text
);
--> statement-breakpoint

-- Internal helpers (no grant).

CREATE FUNCTION assert_context(p_context audit_context, p_participation_id uuid, p_allowed actor_type[])
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Fails closed: an unknown actor or a missing allow-list (e.g. no creation edge) is refused.
  IF NOT coalesce(p_context.actor_type = ANY (p_allowed), false) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  -- Assisted mode and participant actors act for this participation only.
  IF p_context.on_behalf_of IS DISTINCT FROM NULL AND p_context.on_behalf_of IS DISTINCT FROM p_participation_id
     OR p_context.actor_type = 'participant' AND p_context.participation_id IS DISTINCT FROM p_participation_id THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION write_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_field status_field, p_from text, p_to text, p_reason_code text, p_effective_date date,
  p_details jsonb, p_flagged_for_review boolean
) RETURNS uuid LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.audit_event (
    project_id, participation_id, event_type, actor_type, actor_staff_user_id,
    actor_participation_id, system_job, on_behalf_of_participation_id, field, from_value, to_value,
    reason_code, effective_date, request_id, job_id, details, flagged_for_review
  ) VALUES (
    p_project_id, p_participation_id, p_event_type, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).participation_id, (p_context).system_job, (p_context).on_behalf_of, p_field, p_from, p_to,
    p_reason_code, p_effective_date, (p_context).request_id, (p_context).job_id,
    coalesce(p_details, '{}'), p_flagged_for_review
  ) RETURNING id
$$;
--> statement-breakpoint

-- The phase of an end reason (Q34): kept equal to the domain's endReasonsForPhase by a drift test.
CREATE FUNCTION end_reason_fits(p_status main_status, p_reason end_reason)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_status
    WHEN 'withdrawn' THEN p_reason = ANY ('{declined_profiling,declined_dsv,no_response,never_contacted,not_informed,placed_direct,self_employed,retirement,other_measure,deceased,other}'::public.end_reason[])
    WHEN 'exited' THEN p_reason = ANY ('{placed_permanent,placed_fixed_term,self_employed,retirement,apprenticeship_or_study,max_duration_reached,own_termination_without_job,terminated_by_tg,long_term_illness_reduced_earning_capacity,deceased,other}'::public.end_reason[])
    ELSE false
  END
$$;
--> statement-breakpoint

-- The nine functions transfer_app may execute.

-- SELECT … FOR UPDATE needs UPDATE privilege, which transfer_app doesn't have: the status service
-- locks through this. The lock lasts until the caller's transaction ends.
CREATE FUNCTION lock_participation(p_id uuid)
RETURNS participation LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
BEGIN
  SELECT * INTO r FROM public.participation WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- Creation along the domain's creation edge (`imported`, by a user); the self-registration of
-- Slice 4c has its own flow. `p_id` lets the seed use fixed UUIDs.
CREATE FUNCTION create_participation(
  p_project_id uuid, p_context audit_context, p_entry_wave_id uuid DEFAULT NULL, p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_type public.project_type;
BEGIN
  PERFORM public.assert_context(p_context, v_id, (
    SELECT actors FROM public.lifecycle_edge
    WHERE track = 'main' AND from_value IS NULL AND to_value = 'imported' AND kind = 'manual'));
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

-- One track moves one step (compare-and-set on `p_expected_from`), with its dependent columns and
-- exactly one status_changed event. A pending profiling exception request the change makes stale
-- is superseded in the same transaction (round 10). Returns the status_changed event's id.
CREATE FUNCTION change_participation_status(
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
       OR cardinality(v_secondary) <> (SELECT count(DISTINCT s) FROM unnest(v_secondary) s) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSIF p_end_reason IS NOT NULL OR cardinality(v_secondary) > 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  IF p_effective_date IS NULL AND p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done') THEN
    RAISE EXCEPTION 'effective_date_required';
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
    jsonb_strip_nulls(jsonb_build_object(
      'entryKind', p_entry_kind,
      'scheduledAt', to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'secondaryReasons', CASE WHEN cardinality(v_secondary) > 0 THEN to_jsonb(v_secondary) END,
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
        jsonb_build_object('profilingExceptionRequestId', v_request.id, 'statusChangeId', v_event), false);
    END IF;
  END IF;
  RETURN v_event;
END $$;
--> statement-breakpoint

-- Wave (re)assignment only before the first offer (Q79, round 10).
CREATE FUNCTION assign_entry_wave(p_id uuid, p_wave_id uuid, p_context audit_context)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  r := public.lock_participation(p_id);
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF r.status NOT IN ('imported', 'contacted', 'unreachable', 'informed') THEN
    RAISE EXCEPTION 'status_not_open';
  END IF;
  IF r.dsv_status <> 'not_offered' THEN
    RAISE EXCEPTION 'dsv_already_offered';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_entry_wave WHERE id = p_wave_id AND project_id = r.project_id) THEN
    RAISE EXCEPTION 'wave_of_other_project';
  END IF;
  -- Assigning the current wave again is a no-op, refused without a write (round 16).
  IF r.entry_wave_id = p_wave_id THEN
    RAISE EXCEPTION 'wave_unchanged';
  END IF;
  UPDATE public.participation SET entry_wave_id = p_wave_id, status_version = status_version + 1 WHERE id = p_id;
  RETURN public.write_audit_event(r.project_id, p_id, 'entry_wave_assigned', p_context, NULL, NULL, NULL,
    NULL, NULL, jsonb_build_object('waveId', p_wave_id, 'previousWaveId', r.entry_wave_id), false);
END $$;
--> statement-breakpoint

-- Each request is its own immutable row, authoritative for its history (Q94, round 16); the
-- participation points at its current one. Changed evidence means a different fingerprint than
-- the latest request's. The service refuses real requests until Slice 4b validates evidence.
CREATE FUNCTION request_profiling_exception(
  p_id uuid, p_reason profiling_exception_reason, p_requested_on date, p_evidence_record_id uuid,
  p_evidence_fingerprint text, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_latest public.profiling_exception_request;
  v_request_id uuid;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_reason IS NULL OR p_requested_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  SELECT * INTO v_latest FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  IF v_latest.status IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'exception_open';
  END IF;
  IF p_evidence_record_id IS NULL OR p_evidence_fingerprint IS NULL THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  IF p_evidence_fingerprint = v_latest.evidence_fingerprint THEN
    RAISE EXCEPTION 'evidence_unchanged';
  END IF;
  INSERT INTO public.profiling_exception_request (
    project_id, participation_id, reason_code, status, requested_by, requested_on,
    evidence_record_id, evidence_fingerprint
  ) VALUES (
    r.project_id, p_id, p_reason, 'requested', (p_context).staff_user_id, p_requested_on,
    p_evidence_record_id, p_evidence_fingerprint
  ) RETURNING id INTO v_request_id;
  UPDATE public.participation
  SET profiling_exception_request_id = v_request_id, status_version = status_version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_requested', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    jsonb_build_object('profilingExceptionRequestId', v_request_id,
      'evidenceRecordId', p_evidence_record_id, 'evidenceFingerprint', p_evidence_fingerprint), false);
  RETURN v_request_id;
END $$;
--> statement-breakpoint

-- Locks the participation of a request and returns the request, which must be the current one.
CREATE FUNCTION lock_current_request(p_request_id uuid, p_context audit_context)
RETURNS public.profiling_exception_request LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation_id uuid;
  v_request public.profiling_exception_request;
BEGIN
  SELECT participation_id INTO v_participation_id FROM public.profiling_exception_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (public.lock_participation(v_participation_id)).profiling_exception_request_id IS DISTINCT FROM p_request_id THEN
    RAISE EXCEPTION 'request_not_current';
  END IF;
  SELECT * INTO v_request FROM public.profiling_exception_request WHERE id = p_request_id;
  RETURN v_request;
END $$;
--> statement-breakpoint

-- Four eyes (Q80): a different staff user approves or rejects the current pending request; an
-- approval counts from its date and the instant it was recorded (round 9).
CREATE FUNCTION decide_profiling_exception(
  p_request_id uuid, p_approve boolean, p_decided_on date, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.profiling_exception_request;
  r public.participation;
BEGIN
  IF p_approve IS NULL OR p_decided_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'not_requested';
  END IF;
  IF v_request.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  UPDATE public.profiling_exception_request SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.profiling_exception_status,
    decided_by = (p_context).staff_user_id,
    decided_on = p_decided_on,
    decided_at = now()
  WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id,
    CASE WHEN p_approve THEN 'profiling_exception_approved' ELSE 'profiling_exception_rejected' END::public.audit_event_type,
    p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $$;
--> statement-breakpoint

-- The PL withdraws the current, still-applicable request or approval before TG entry; one that
-- no longer applies is superseded instead (round 10).
CREATE FUNCTION revoke_profiling_exception(p_request_id uuid, p_context audit_context)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.profiling_exception_request;
  r public.participation;
BEGIN
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.status NOT IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'not_revocable';
  END IF;
  IF r.status IN ('withdrawn', 'rejected', 'ta_completed', 'exited')
     OR (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg'
     OR r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'no_longer_applicable';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  UPDATE public.profiling_exception_request SET status = 'revoked' WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id, 'profiling_exception_revoked', p_context, NULL,
    NULL, NULL, NULL, NULL, jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $$;
--> statement-breakpoint

-- Defence in depth for "immutable request" (round 16), whoever writes: the reason, the evidence
-- identity and the request itself never change; the status only progresses
-- (requested → approved/rejected/revoked/superseded, approved → revoked) and a decision, once
-- recorded, stays as it is.
CREATE FUNCTION profiling_exception_request_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.project_id, NEW.participation_id, NEW.reason_code, NEW.requested_by,
      NEW.requested_on, NEW.requested_at, NEW.evidence_record_id, NEW.evidence_fingerprint)
     IS DISTINCT FROM
     (OLD.id, OLD.project_id, OLD.participation_id, OLD.reason_code, OLD.requested_by,
      OLD.requested_on, OLD.requested_at, OLD.evidence_record_id, OLD.evidence_fingerprint)
     OR OLD.decided_by IS NOT NULL
       AND (NEW.decided_by, NEW.decided_on, NEW.decided_at) IS DISTINCT FROM (OLD.decided_by, OLD.decided_on, OLD.decided_at)
     OR NOT (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'revoked', 'superseded')
             OR OLD.status = 'approved' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER profiling_exception_request_progresses BEFORE UPDATE ON profiling_exception_request
FOR EACH ROW EXECUTE FUNCTION profiling_exception_request_progresses();
--> statement-breakpoint

-- Q72, round 10: the primary reason changes without reopening the terminal status. A
-- system-derived previous reason moves to the secondary list; a previous staff reason only when
-- the PL confirms it still applies.
CREATE FUNCTION correct_end_reason(
  p_id uuid, p_new_reason end_reason, p_context audit_context, p_previous_still_applies boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_secondary public.end_reason[];
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_new_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  IF r.status NOT IN ('withdrawn', 'exited') THEN
    RAISE EXCEPTION 'no_end_reason';
  END IF;
  IF NOT public.end_reason_fits(r.status, p_new_reason) THEN
    RAISE EXCEPTION 'reason_wrong_phase';
  END IF;
  IF p_new_reason = 'long_term_illness_reduced_earning_capacity' THEN
    RAISE EXCEPTION 'reason_not_storable';
  END IF;
  IF p_new_reason = r.end_reason THEN
    RAISE EXCEPTION 'reason_unchanged';
  END IF;
  -- The kept previous reason first, then the existing secondary ones; no duplicates, not the new one.
  SELECT coalesce(array_agg(reason ORDER BY ord), '{}') INTO v_secondary
  FROM (
    SELECT reason, min(ord) AS ord
    FROM unnest(CASE WHEN r.end_reason_source = 'system' OR p_previous_still_applies THEN ARRAY[r.end_reason] ELSE '{}' END
                || r.end_reason_secondary) WITH ORDINALITY AS u(reason, ord)
    WHERE reason <> p_new_reason
    GROUP BY reason
  ) kept;
  UPDATE public.participation SET
    end_reason = p_new_reason, end_reason_source = 'user', end_reason_secondary = v_secondary,
    status_version = status_version + 1
  WHERE id = p_id;
  RETURN public.write_audit_event(r.project_id, p_id, 'end_reason_corrected', p_context, NULL,
    r.end_reason::text, p_new_reason::text, p_new_reason::text, NULL,
    jsonb_build_object('previousSource', r.end_reason_source, 'secondaryReasons', to_jsonb(v_secondary)), false);
END $$;
--> statement-breakpoint

-- Every other event type (Slices 3–9); the lifecycle and exception types only through their
-- functions above.
CREATE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected') THEN
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

-- Grants (plan 5.4). transfer_app reads participations, their exception requests and waves,
-- writes nothing directly, has no
-- privilege on audit_event or lifecycle_edge, and executes the nine functions.
REVOKE ALL ON FUNCTION assert_context, write_audit_event, end_reason_fits, lock_current_request,
  profiling_exception_request_progresses, lock_participation,
  create_participation, change_participation_status, assign_entry_wave, request_profiling_exception,
  decide_profiling_exception, revoke_profiling_exception, correct_end_reason, record_audit_event FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lock_participation, create_participation, change_participation_status,
  assign_entry_wave, request_profiling_exception, decide_profiling_exception, revoke_profiling_exception,
  correct_end_reason, record_audit_event TO transfer_app;
--> statement-breakpoint
GRANT SELECT ON TABLE participation, profiling_exception_request, project_entry_wave TO transfer_app;
