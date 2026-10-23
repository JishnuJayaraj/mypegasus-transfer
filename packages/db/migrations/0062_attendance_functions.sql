-- Hand-written (ADR-0002, appointments; process-and-lifecycle.md and data-protection.md,
-- appointments: attendance; Q163, Q164, Q168): recording attendance, the two-step `informed`,
-- the basis and its conflict, the PL's correction of false no-shows, the history's projection
-- rows and the grants. Same hardening as 0060: SECURITY DEFINER owned by transfer_owner, a fixed
-- search_path with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for
-- transfer_app, database time, refusals as P0001 with a stable code, never a value. Audit details
-- carry ids, codes and times only, never the title or the venue. The new enum values of 0061 are
-- compared as text here, since this runs after them in the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock first, exclusive for the bulk recording and
-- the appointment's cancellation, shared through `lock_participation` for one booking; then
-- participation rows in UUID order → the appointment row → booking rows in id order. Status
-- changes go through `apply_status_change` only, which re-checks the edge, the project and the
-- track; the `before_cutoff` guard of `unreachable → contacted` is checked here with database
-- time.

ALTER TABLE audit_event DROP CONSTRAINT audit_event_lifecycle_has_participation;
--> statement-breakpoint
ALTER TABLE audit_event ADD CONSTRAINT audit_event_lifecycle_has_participation CHECK (
  participation_id IS NOT NULL OR event_type::text NOT IN (
    'participation_created', 'status_changed', 'entry_wave_assigned',
    'profiling_exception_requested', 'profiling_exception_approved',
    'profiling_exception_rejected', 'profiling_exception_revoked',
    'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed',
    'participation_created_manually', 'participation_dates_changed', 'sensitive_read',
    'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned',
    'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
    'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
    'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
    'one_time_code_exhausted', 'participant_logout', 'participant_login',
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended', 'placement_agentur_set',
    'self_service_notice_acknowledged', 'step_up_completed', 'step_up_failed',
    'assisted_mode_started', 'assisted_mode_ended', 'document_added', 'document_reviewed',
    'document_deleted', 'document_upload_rejected', 'reminder_queued', 'reminder_delivery',
    'audit_history_opened', 'appointment_booked', 'appointment_booking_cancelled',
    'attendance_recorded', 'attendance_superseded', 'information_delivery_confirmed',
    'attendance_conflict_escalated', 'attendance_conflict_resolved'));
--> statement-breakpoint

-- The domain's `auditProjection` for the new types (the drift test holds them equal).
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('attendance_recorded', NULL, 'case', false, true,
    '{appointmentId,appointmentKind,startsAt,attendance,previousAttendance,afterClose}'),
  ('attendance_superseded', NULL, 'case', false, false,
    '{appointmentId,appointmentKind,startsAt,previousAttendance}'),
  ('information_delivery_confirmed', NULL, 'case', false, false,
    '{appointmentId,appointmentKind,startsAt,statusChanged}'),
  ('attendance_conflict_escalated', NULL, 'case', false, false,
    '{appointmentId,appointmentKind,startsAt}'),
  ('attendance_conflict_resolved', NULL, 'case', false, true,
    '{appointmentId,appointmentKind,startsAt}');
--> statement-breakpoint

-- Internal helpers (no grant).

-- A booking event's details: the booking, its appointment, kind and start as written then (Q168).
CREATE FUNCTION booking_event_details(b appointment_booking, a appointment)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('bookingId', b.id, 'appointmentId', a.id,
    'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at))
$$;
--> statement-breakpoint

-- When the participation became terminal (its latest `status_changed` to a terminal status), or
-- null while it isn't.
CREATE FUNCTION participation_closed_at(p participation)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p.status IN ('withdrawn', 'ta_completed', 'exited') THEN (
    SELECT pg_catalog.max(e.occurred_at) FROM public.audit_event e
    WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status'
      AND e.to_value IN ('withdrawn', 'ta_completed', 'exited')) END
$$;
--> statement-breakpoint

-- A basis whose attendance is corrected to `absent`, without a resolution (Q163).
CREATE FUNCTION booking_conflict_open(b appointment_booking)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT b.informed_basis_at IS NOT NULL AND b.attendance::text = 'absent'
    AND b.conflict_resolution IS NULL
$$;
--> statement-breakpoint

-- "Als informiert erfassen" on a qualifying attendance (Q163): marks the booking as the basis,
-- writes `information_delivery_confirmed`, then the changes along the `manual` edges as the
-- confirming staff user, each its own `status_changed` through `apply_status_change`:
-- `contacted → informed`, `imported → contacted → informed`, `unreachable → contacted`
-- (`before_cutoff`, database time) `→ informed`. The PL and the assigned consultant, the only
-- callers, may take these edges (Q60). The caller holds the participation and the booking.
-- Returns the number of status changes.
CREATE FUNCTION confirm_informed(
  p participation, b appointment_booking, a appointment, p_context audit_context
) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_changes integer := 1;
BEGIN
  IF p.status = 'unreachable' AND NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'before_cutoff';
  END IF;
  UPDATE public.appointment_booking SET informed_basis_by = (p_context).staff_user_id,
    informed_basis_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'information_delivery_confirmed', p_context,
    NULL, NULL, NULL, NULL, NULL,
    public.booking_event_details(b, a) || '{"statusChanged": true}'::jsonb, false);
  IF p.status IN ('imported', 'unreachable') THEN
    PERFORM public.apply_status_change(p.id, 'status', p.status::text, 'contacted', p_context);
    v_changes := 2;
  END IF;
  PERFORM public.apply_status_change(p.id, 'status', 'contacted', 'informed', p_context);
  RETURN v_changes;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- Attendance of an appointment (Q163, Q164; the domain's `attendanceEligibility`): rows i of the
-- three arrays, 1–500, each participation once, all or nothing, by the PL or the assigned
-- consultant in normal mode, under the exclusive project lock: the named participations in UUID
-- order, the appointment, its live bookings of them in id order. `attended` from the start,
-- `absent` after the end; a correction to the other value of a recorded one (audited with the
-- previous value) never changes a status. A participation without a live booking is a walk-in
-- (`attended`; for a consultation one its host may list): a booking of origin `walk_in`. After a
-- participation closed, the PL alone records on its live booking (an appointment that started
-- before the close) with `p_after_close_reason`, never a status change. A ticked
-- `p_mark_informed` on a first `attended` record before `informed` needs
-- `p_information_delivered` and runs `confirm_informed`. Refuses `invalid_argument`,
-- `actor_not_allowed`, `appointment_not_found`, `project_not_active`, `appointment_cancelled`,
-- `information_delivery_unconfirmed`, then per row in order `participation_not_found`,
-- `actor_not_allowed`, `appointment_not_started`, `appointment_not_ended`,
-- `participation_closed`, `after_close_reason_required`, `started_after_close`, `not_booked`,
-- `host_not_responsible`, `attendance_unchanged`, `mark_informed_not_allowed`, `before_cutoff`.
-- Returns `{ recorded, informed, statusChanges }`.
CREATE FUNCTION record_attendance(
  p_context audit_context, p_appointment_id uuid, p_participation_ids uuid[],
  p_attendance attendance[], p_mark_informed boolean[], p_information_delivered boolean,
  p_after_close_reason attendance_after_close_reason DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_count integer := pg_catalog.cardinality(p_participation_ids);
  v_project uuid;
  a public.appointment;
  p public.participation;
  b public.appointment_booking;
  v_roles text[];
  v_found boolean;
  v_closed boolean;
  v_attendance public.attendance;
  v_previous public.attendance;
  v_recorded integer := 0;
  v_informed integer := 0;
  v_changes integer := 0;
BEGIN
  IF p_appointment_id IS NULL OR p_information_delivered IS NULL OR v_count IS NULL
     OR v_count NOT BETWEEN 1 AND 500
     OR pg_catalog.cardinality(p_attendance) IS DISTINCT FROM v_count
     OR pg_catalog.cardinality(p_mark_informed) IS DISTINCT FROM v_count
     OR pg_catalog.array_position(p_participation_ids, NULL) IS NOT NULL
     OR pg_catalog.array_position(p_attendance, NULL) IS NOT NULL
     OR pg_catalog.array_position(p_mark_informed, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_participation_ids) x) <> v_count THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  PERFORM FROM public.participation q WHERE q.id = ANY (p_participation_ids)
  ORDER BY q.id FOR UPDATE;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  PERFORM FROM public.appointment_booking bk
  WHERE bk.appointment_id = a.id AND bk.status = 'booked'
    AND bk.participation_id = ANY (p_participation_ids)
  ORDER BY bk.id FOR UPDATE;
  IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF true = ANY (p_mark_informed) AND NOT p_information_delivered THEN
    RAISE EXCEPTION 'information_delivery_unconfirmed';
  END IF;

  FOR i IN 1 .. v_count LOOP
    SELECT * INTO p FROM public.participation
    WHERE id = p_participation_ids[i] AND project_id = v_project;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'participation_not_found';
    END IF;
    v_roles := public.document_staff_roles(p.id, (p_context).staff_user_id);
    IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    v_attendance := p_attendance[i];
    v_closed := p.status IN ('withdrawn', 'ta_completed', 'exited');
    IF v_attendance = 'attended' AND now() < a.starts_at THEN
      RAISE EXCEPTION 'appointment_not_started';
    END IF;
    IF v_attendance = 'absent' AND now() < a.ends_at THEN
      RAISE EXCEPTION 'appointment_not_ended';
    END IF;
    SELECT * INTO b FROM public.appointment_booking
    WHERE appointment_id = a.id AND participation_id = p.id AND status = 'booked';
    v_found := FOUND;
    IF v_closed THEN
      IF NOT 'project_lead' = ANY (v_roles) OR NOT v_found THEN
        RAISE EXCEPTION 'participation_closed';
      END IF;
      IF p_after_close_reason IS NULL THEN
        RAISE EXCEPTION 'after_close_reason_required';
      END IF;
      IF a.starts_at >= coalesce(public.participation_closed_at(p), '-infinity'::timestamptz) THEN
        RAISE EXCEPTION 'started_after_close';
      END IF;
    END IF;
    IF NOT v_found THEN
      IF v_attendance <> 'attended' THEN
        RAISE EXCEPTION 'not_booked';
      END IF;
      IF a.kind = 'consultation' AND NOT public.appointment_staff_allowed(p.id, a.host_staff_user_id) THEN
        RAISE EXCEPTION 'host_not_responsible';
      END IF;
    ELSIF b.attendance IS NOT DISTINCT FROM v_attendance THEN
      RAISE EXCEPTION 'attendance_unchanged';
    END IF;
    IF p_mark_informed[i] AND NOT (v_attendance = 'attended' AND NOT v_closed
         AND (NOT v_found OR b.attendance IS NULL)
         AND p.status IN ('imported', 'contacted', 'unreachable')) THEN
      RAISE EXCEPTION 'mark_informed_not_allowed';
    END IF;

    IF v_found THEN
      v_previous := b.attendance;
      UPDATE public.appointment_booking SET attendance = v_attendance,
        attendance_recorded_by = (p_context).staff_user_id, attendance_recorded_at = now(),
        after_close_reason = CASE WHEN v_closed THEN p_after_close_reason END
      WHERE id = b.id
      RETURNING * INTO b;
    ELSE
      v_previous := NULL;
      INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
        origin, booked_by, attendance, attendance_recorded_by, attendance_recorded_at)
      VALUES (pg_catalog.gen_random_uuid(), v_project, p.id, a.id, 'walk_in',
        (p_context).staff_user_id, v_attendance, (p_context).staff_user_id, now())
      RETURNING * INTO b;
      PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL,
        NULL, NULL, NULL, NULL,
        public.booking_event_details(b, a) || '{"origin": "walk_in"}'::jsonb, false);
    END IF;
    PERFORM public.write_audit_event(v_project, p.id, 'attendance_recorded', p_context, NULL,
      NULL, NULL, CASE WHEN v_closed THEN p_after_close_reason::text END, NULL,
      public.booking_event_details(b, a) || pg_catalog.jsonb_build_object(
        'attendance', v_attendance, 'previousAttendance', v_previous, 'afterClose', v_closed),
      false);
    v_recorded := v_recorded + 1;
    IF p_mark_informed[i] THEN
      v_changes := v_changes + public.confirm_informed(p, b, a, p_context);
      v_informed := v_informed + 1;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('recorded', v_recorded, 'informed', v_informed,
    'statusChanges', v_changes);
END $$;
--> statement-breakpoint

-- "Als informiert erfassen" or "Als Grundlage bestätigen" on one booking (Q163; the domain's
-- `informedConfirmation`), with the delivery confirmed, by the PL or the assigned consultant in
-- normal mode: the participation (shared project lock) → the appointment → the participation's
-- bookings in id order. On a qualifying attendance (`attended`, of a participation before
-- `informed`) it runs `confirm_informed`; while another booking of the participation is a basis
-- in conflict, it marks this one as the replacement basis without a status change
-- (`information_delivery_confirmed` with `statusChanged: false`) and resolves each conflict
-- `replacement_basis` (after the close the PL only). Refuses `invalid_argument`,
-- `booking_not_found`, `actor_not_allowed`, `information_delivery_unconfirmed`,
-- `project_not_active`, `booking_cancelled`, `not_attended`, `already_basis`, `before_cutoff`,
-- `participation_closed`, `already_informed`. Returns the number of status changes.
CREATE FUNCTION confirm_information_delivered(
  p_context audit_context, p_booking_id uuid, p_information_delivered boolean
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation uuid;
  v_appointment uuid;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
  c public.appointment_booking;
  v_roles text[];
  v_closed boolean;
BEGIN
  IF p_booking_id IS NULL OR p_information_delivered IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, appointment_id INTO v_participation, v_appointment
  FROM public.appointment_booking WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  v_roles := public.document_staff_roles(p.id, (p_context).staff_user_id);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = v_appointment FOR SHARE;
  PERFORM FROM public.appointment_booking WHERE participation_id = p.id ORDER BY id FOR UPDATE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id;
  IF NOT p_information_delivered THEN
    RAISE EXCEPTION 'information_delivery_unconfirmed';
  END IF;
  IF (SELECT status FROM public.project WHERE id = p.project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'booking_cancelled';
  END IF;
  IF b.attendance IS DISTINCT FROM 'attended' THEN
    RAISE EXCEPTION 'not_attended';
  END IF;
  IF b.informed_basis_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_basis';
  END IF;
  IF p.status IN ('imported', 'contacted', 'unreachable') AND b.after_close_reason IS NULL THEN
    RETURN public.confirm_informed(p, b, a, p_context);
  END IF;
  v_closed := p.status IN ('withdrawn', 'ta_completed', 'exited');
  IF EXISTS (SELECT FROM public.appointment_booking x
             WHERE x.participation_id = p.id AND public.booking_conflict_open(x))
     AND (NOT v_closed OR 'project_lead' = ANY (v_roles)) THEN
    UPDATE public.appointment_booking SET informed_basis_by = (p_context).staff_user_id,
      informed_basis_at = now()
    WHERE id = b.id;
    PERFORM public.write_audit_event(p.project_id, p.id, 'information_delivery_confirmed',
      p_context, NULL, NULL, NULL, NULL, NULL,
      public.booking_event_details(b, a) || '{"statusChanged": false}'::jsonb, false);
    FOR c IN SELECT * FROM public.appointment_booking x
             WHERE x.participation_id = p.id AND public.booking_conflict_open(x) ORDER BY x.id LOOP
      UPDATE public.appointment_booking SET conflict_resolution = 'replacement_basis',
        conflict_resolved_by = (p_context).staff_user_id, conflict_resolved_at = now()
      WHERE id = c.id;
      PERFORM public.write_audit_event(p.project_id, p.id, 'attendance_conflict_resolved',
        p_context, NULL, NULL, NULL, 'replacement_basis', NULL,
        public.booking_event_details(c, (SELECT x FROM public.appointment x WHERE x.id = c.appointment_id))
          || pg_catalog.jsonb_build_object('basisBookingId', b.id), false);
    END LOOP;
    RETURN 0;
  END IF;
  RAISE EXCEPTION '%', CASE WHEN v_closed THEN 'participation_closed' ELSE 'already_informed' END;
END $$;
--> statement-breakpoint

-- The booking of a conflict, under the participation's lock (shared project lock) → its
-- appointment → the booking, by the PL of the project (Q163), also after the close. Raises
-- `invalid_argument`, `booking_not_found`, `actor_not_allowed`, `no_conflict`.
CREATE FUNCTION lock_conflict_booking(p_context audit_context, p_booking_id uuid)
RETURNS appointment_booking LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation uuid;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.appointment_booking
  WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  PERFORM public.lock_participation(v_participation);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(v_participation,
       (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.appointment x WHERE x.id = (
    SELECT appointment_id FROM public.appointment_booking WHERE id = p_booking_id) FOR SHARE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF NOT public.booking_conflict_open(b) THEN
    RAISE EXCEPTION 'no_conflict';
  END IF;
  RETURN b;
END $$;
--> statement-breakpoint

-- The PL records `escalated` as a conflict's handling state (Q163): the item stays open until a
-- resolution. Refuses as `lock_conflict_booking`, and `already_escalated`.
CREATE FUNCTION escalate_attendance_conflict(p_context audit_context, p_booking_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.appointment_booking := public.lock_conflict_booking(p_context, p_booking_id);
BEGIN
  IF b.conflict_escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_escalated';
  END IF;
  UPDATE public.appointment_booking SET conflict_escalated_by = (p_context).staff_user_id,
    conflict_escalated_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'attendance_conflict_escalated', p_context, NULL, NULL, NULL, NULL, NULL,
    public.booking_event_details(b, (SELECT x FROM public.appointment x WHERE x.id = b.appointment_id)),
    false);
END $$;
--> statement-breakpoint

-- The PL's attestation `information_delivered_otherwise` (Q163) resolves a conflict without a
-- status change; a replacement basis goes through `confirm_information_delivered`. Refuses as
-- `lock_conflict_booking`, and `invalid_argument` for another resolution.
CREATE FUNCTION resolve_attendance_conflict(
  p_context audit_context, p_booking_id uuid, p_resolution attendance_conflict_resolution
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.appointment_booking;
BEGIN
  IF p_resolution IS DISTINCT FROM 'information_delivered_otherwise' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_conflict_booking(p_context, p_booking_id);
  UPDATE public.appointment_booking SET conflict_resolution = p_resolution,
    conflict_resolved_by = (p_context).staff_user_id, conflict_resolved_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'attendance_conflict_resolved', p_context, NULL, NULL, NULL, p_resolution::text, NULL,
    public.booking_event_details(b, (SELECT x FROM public.appointment x WHERE x.id = b.appointment_id)),
    false);
END $$;
--> statement-breakpoint

-- Replaced (Q164): no cancellation once attendance is recorded (`attendance_recorded`), except
-- the PL's `did_not_take_place` correction over absences only: each absence is superseded
-- (`attendance_superseded`, kept in the booking's history) and its booking cancelled with the
-- appointment, so no missed appointment remains; `appointment_cancelled` with `correction: true`.
-- Otherwise unchanged (0060).
CREATE OR REPLACE FUNCTION cancel_appointment(
  p_context audit_context, p_id uuid, p_reason appointment_cancel_reason
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  a public.appointment;
  b public.appointment_booking;
  v_roles text[];
  v_recorded text[];
  v_correction boolean := false;
  v_count integer := 0;
BEGIN
  IF p_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  PERFORM public.lock_appointment_participations(p_id);
  SELECT * INTO a FROM public.appointment WHERE id = p_id FOR UPDATE;
  v_roles := public.assert_appointment_manager(v_project, (p_context).staff_user_id, a.kind,
    a.host_staff_user_id);
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  PERFORM FROM public.appointment_booking WHERE appointment_id = p_id AND status = 'booked'
  ORDER BY id FOR UPDATE;
  v_recorded := ARRAY(SELECT attendance::text FROM public.appointment_booking
                      WHERE appointment_id = p_id AND status = 'booked' AND attendance IS NOT NULL);
  IF pg_catalog.cardinality(v_recorded) > 0 THEN
    IF p_reason = 'did_not_take_place' AND 'project_lead' = ANY (v_roles)
       AND 'absent' = ALL (v_recorded) THEN
      v_correction := true;
    ELSE
      RAISE EXCEPTION 'attendance_recorded';
    END IF;
  END IF;
  FOR b IN SELECT * FROM public.appointment_booking
           WHERE appointment_id = p_id AND status = 'booked' ORDER BY id LOOP
    IF b.attendance IS NOT NULL THEN
      PERFORM public.write_audit_event(b.project_id, b.participation_id, 'attendance_superseded',
        p_context, NULL, NULL, NULL, NULL, NULL,
        public.booking_event_details(b, a) || '{"previousAttendance": "absent"}'::jsonb, false);
    END IF;
    PERFORM public.cancel_booking_row(b, a, 'appointment_cancelled', p_context);
    IF b.attendance IS NOT NULL THEN
      UPDATE public.appointment_booking SET attendance_superseded_by = (p_context).staff_user_id,
        attendance_superseded_at = now()
      WHERE id = b.id;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  UPDATE public.appointment SET status = 'cancelled', cancel_reason = p_reason,
    cancelled_at = now(), version = version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_cancelled', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('appointmentId', p_id, 'correction', v_correction), false);
  RETURN v_count;
END $$;
--> statement-breakpoint

-- Replaced: a booking with attendance recorded isn't cancelled (`attendance_recorded`, Q164).
-- Otherwise unchanged (0060).
CREATE OR REPLACE FUNCTION cancel_appointment_booking(p_context audit_context, p_booking_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation uuid;
  v_appointment uuid;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, appointment_id INTO v_participation, v_appointment
  FROM public.appointment_booking WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = v_appointment FOR UPDATE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'booking_cancelled';
  END IF;
  IF b.attendance IS NOT NULL THEN
    RAISE EXCEPTION 'attendance_recorded';
  END IF;
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  PERFORM public.cancel_booking_row(b, a, 'staff_cancelled', p_context);
END $$;
--> statement-breakpoint

-- Replaced: the attendance events are written only by their functions too.
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
      'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
      'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
      'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
      'one_time_code_exhausted', 'participant_logout', 'participant_login',
      'contact_channel_removed', 'consent_ended', 'contact_channels_suspended',
      'placement_agentur_set', 'self_service_notice_acknowledged', 'step_up_completed',
      'step_up_failed', 'assisted_mode_started', 'assisted_mode_ended', 'document_opened',
      'document_added', 'document_reviewed', 'document_deleted', 'document_upload_rejected',
      'reminder_queued', 'reminder_delivery', 'audit_history_opened', 'appointment_created',
      'appointment_changed', 'appointment_cancelled', 'appointment_booked',
      'appointment_booking_cancelled', 'attendance_recorded', 'attendance_superseded',
      'information_delivery_confirmed', 'attendance_conflict_escalated',
      'attendance_conflict_resolved') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context,
    NULL, NULL, NULL, p_reason_code, p_effective_date, p_details,
    coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION booking_event_details, participation_closed_at, booking_conflict_open,
  confirm_informed, lock_conflict_booking, record_attendance, confirm_information_delivered,
  escalate_attendance_conflict, resolve_attendance_conflict FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_attendance, confirm_information_delivered,
  escalate_attendance_conflict, resolve_attendance_conflict TO transfer_app;
