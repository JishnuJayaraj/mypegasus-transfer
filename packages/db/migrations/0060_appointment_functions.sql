-- Hand-written (ADR-0002, appointments; process-and-lifecycle.md and data-protection.md,
-- appointments; Q162, Q164, Q166, Q168): the appointment functions, the terminal cancellation of
-- bookings, the history's projection rows and the grants. Same hardening as 0058: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. Audit details carry ids, codes and times only: never the title or the
-- venue. The new enum values of 0059 are compared as text here, since this runs after them in
-- the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock first, shared through `lock_participation`
-- for one participation, exclusive for an appointment's own changes; then participation rows in
-- UUID order → the appointment row → booking rows in id order. Never an appointment before a
-- participation. A host's slots serialise on the host's advisory lock after the project lock.

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
    'audit_history_opened', 'appointment_booked', 'appointment_booking_cancelled'));
--> statement-breakpoint

-- The domain's `auditProjection` for the new types (the drift test holds them equal).
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('appointment_created', NULL, NULL, false, false, '{}'),
  ('appointment_changed', NULL, NULL, false, false, '{}'),
  ('appointment_cancelled', NULL, NULL, false, false, '{}'),
  ('appointment_booked', NULL, 'case', false, false,
    '{appointmentId,appointmentKind,startsAt,origin}'),
  ('appointment_booking_cancelled', NULL, 'case', false, true,
    '{appointmentId,appointmentKind,startsAt}');
--> statement-breakpoint
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('appointmentBookings', 'case_internal');
--> statement-breakpoint

-- Internal helpers (no grant).

-- The project roles of an active staff user in a project.
CREATE FUNCTION appointment_member_roles(p_project_id uuid, p_staff_user_id uuid)
RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(
    SELECT DISTINCT m.role::text FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = p_staff_user_id
    ORDER BY 1)
$$;
--> statement-breakpoint

-- Whether a staff user may list (and so host or book) the participation now (Q62): an active
-- PL of its project, or its consultant while assigned (`document_staff_roles`).
CREATE FUNCTION appointment_staff_allowed(p_participation_id uuid, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.document_staff_roles(p_participation_id, p_staff_user_id)
    && '{project_lead,consultant}'::text[]
$$;
--> statement-breakpoint

-- A generic title or venue (the domain's `AppointmentTitle`, `AppointmentVenue`): trimmed,
-- 1–max characters, no control characters.
CREATE FUNCTION appointment_text_valid(p_value text, p_max integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL AND pg_catalog.char_length(p_value) BETWEEN 1 AND p_max
    AND p_value = pg_catalog.btrim(p_value) AND p_value !~ '[[:cntrl:]]'
$$;
--> statement-breakpoint

-- An event time as written into audit details: UTC ISO 8601 with milliseconds.
CREATE FUNCTION appointment_instant(p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
--> statement-breakpoint

-- The times, capacity and texts of an appointment (the table's CHECKs, as `invalid_argument`).
CREATE FUNCTION appointment_values_valid(
  p_starts_at timestamptz, p_ends_at timestamptz, p_booking_closes_at timestamptz,
  p_capacity integer, p_title text, p_venue text
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_ends_at > p_starts_at AND p_booking_closes_at <= p_starts_at
    AND p_booking_closes_at >= p_starts_at - interval '14 days'
    AND p_capacity BETWEEN 1 AND 500
    AND (p_title IS NULL OR public.appointment_text_valid(p_title, 100))
    AND public.appointment_text_valid(p_venue, 200), false)
$$;
--> statement-breakpoint

-- Serialises the slots of one host across projects, after the project lock (no host overlap).
-- Raises `host_overlap` when another scheduled slot of the host overlaps (touching is fine).
CREATE FUNCTION assert_host_free(
  p_host uuid, p_appointment_id uuid, p_starts_at timestamptz, p_ends_at timestamptz
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('appointment-host:' || p_host::text, 0));
  IF EXISTS (SELECT FROM public.appointment x
             WHERE x.host_staff_user_id = p_host AND x.id <> p_appointment_id
               AND x.status = 'scheduled' AND x.starts_at < p_ends_at
               AND p_starts_at < x.ends_at) THEN
    RAISE EXCEPTION 'host_overlap';
  END IF;
END $$;
--> statement-breakpoint

-- The wave of an info event's audience: a `ta_tg` project's own wave.
CREATE FUNCTION assert_appointment_audience(p_project_id uuid, p_wave_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_wave_id IS NULL THEN RETURN; END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_entry_wave
                 WHERE id = p_wave_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'wave_of_other_project';
  END IF;
END $$;
--> statement-breakpoint

-- Whether the acting staff user manages the appointment (Q162): a PL of the project, or a
-- consultant of it for their own slot. Raises `actor_not_allowed` otherwise.
CREATE FUNCTION assert_appointment_manager(
  p_project_id uuid, p_staff uuid, p_kind appointment_kind, p_host uuid
) RETURNS text[] LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_roles text[] := public.appointment_member_roles(p_project_id, p_staff);
BEGIN
  IF NOT ('project_lead' = ANY (v_roles)
          OR 'consultant' = ANY (v_roles) AND p_kind = 'consultation' AND p_host = p_staff) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  RETURN v_roles;
END $$;
--> statement-breakpoint

-- A staff context acting for themselves (never assisted mode).
CREATE FUNCTION assert_appointment_context(p_context audit_context, p_participation_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
END $$;
--> statement-breakpoint

-- Cancels one live booking with its `appointment_booking_cancelled` event. The caller holds the
-- booking's row lock.
CREATE FUNCTION cancel_booking_row(
  b appointment_booking, a appointment, p_reason booking_cancel_reason, p_context audit_context
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.appointment_booking SET status = 'cancelled', cancel_reason = p_reason,
    cancelled_by = CASE WHEN p_reason IN ('staff_cancelled', 'appointment_cancelled')
                        THEN (p_context).staff_user_id END,
    cancelled_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'appointment_booking_cancelled', p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('bookingId', b.id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at)), false);
END $$;
--> statement-breakpoint

-- Locks the participations with a live booking of the appointment in UUID order (the
-- exclusive-lock operations, before the appointment row).
CREATE FUNCTION lock_appointment_participations(p_appointment_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM FROM public.participation q
  WHERE q.id IN (SELECT b.participation_id FROM public.appointment_booking b
                 WHERE b.appointment_id = p_appointment_id AND b.status = 'booked')
  ORDER BY q.id FOR UPDATE;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A new appointment (Q162, Q164): the PL any, a consultant only their own slot, of the active
-- project, under the exclusive project lock. Refuses `invalid_argument` (the table's rules, a host
-- for a consultation only, a wave for an info event only), `actor_not_allowed` (assisted mode,
-- any other role or slot), `project_not_found`, `project_not_active`, `host_not_allowed` (the
-- host isn't an active PL or consultant of the project), `not_ta_tg`, `wave_of_other_project`,
-- `starts_in_past` (Q170) and `host_overlap`. Audited `appointment_created` (project-level).
CREATE FUNCTION create_appointment(
  p_context audit_context, p_project_id uuid, p_id uuid, p_kind appointment_kind,
  p_host_staff_user_id uuid, p_audience_wave_id uuid, p_starts_at timestamptz,
  p_ends_at timestamptz, p_booking_closes_at timestamptz, p_capacity integer, p_title text,
  p_venue text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_project_id IS NULL OR p_id IS NULL OR p_kind IS NULL
     OR NOT public.appointment_values_valid(p_starts_at, p_ends_at, p_booking_closes_at,
       p_capacity, p_title, p_venue)
     OR (p_kind = 'consultation') <> (p_host_staff_user_id IS NOT NULL)
     OR p_kind = 'consultation' AND p_audience_wave_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  PERFORM public.lock_project_setup(p_project_id);
  IF (SELECT status FROM public.project WHERE id = p_project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  PERFORM public.assert_appointment_manager(p_project_id, (p_context).staff_user_id, p_kind,
    p_host_staff_user_id);
  IF p_kind = 'consultation' AND NOT public.appointment_member_roles(p_project_id,
       p_host_staff_user_id) && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'host_not_allowed';
  END IF;
  PERFORM public.assert_appointment_audience(p_project_id, p_audience_wave_id);
  IF p_starts_at <= now() THEN
    RAISE EXCEPTION 'starts_in_past';
  END IF;
  IF p_kind = 'consultation' THEN
    PERFORM public.assert_host_free(p_host_staff_user_id, p_id, p_starts_at, p_ends_at);
  END IF;
  INSERT INTO public.appointment (id, project_id, kind, host_staff_user_id, audience_wave_id,
    starts_at, ends_at, booking_closes_at, capacity, title, venue, created_by)
  VALUES (p_id, p_project_id, p_kind, p_host_staff_user_id, p_audience_wave_id, p_starts_at,
    p_ends_at, p_booking_closes_at, p_capacity, p_title, p_venue, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'appointment_created', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'appointmentId', p_id, 'kind', p_kind,
      'startsAt', public.appointment_instant(p_starts_at),
      'endsAt', public.appointment_instant(p_ends_at),
      'bookingClosesAt', public.appointment_instant(p_booking_closes_at),
      'capacity', p_capacity, 'hostStaffUserId', p_host_staff_user_id,
      'audienceWaveId', p_audience_wave_id)), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- A change (Q164): the whole new state of the editable fields with the version read, under the
-- exclusive project lock. Refuses `invalid_argument`, `actor_not_allowed`,
-- `appointment_not_found`, `appointment_cancelled`, `stale_version`, `appointment_in_use` (times,
-- cutoff or audience of an appointment that has had a booking: cancel and create anew, Q168),
-- `starts_in_past` (new times), `not_ta_tg`, `wave_of_other_project`, `capacity_below_bookings`,
-- `host_overlap`, `appointment_unchanged`. Title and venue may be corrected with bookings present.
-- Audited `appointment_changed` with the changed keys; returns the new version.
CREATE FUNCTION update_appointment(
  p_context audit_context, p_id uuid, p_expected_version integer, p_starts_at timestamptz,
  p_ends_at timestamptz, p_booking_closes_at timestamptz, p_capacity integer, p_title text,
  p_venue text, p_audience_wave_id uuid
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  a public.appointment;
  v_fields text[] := '{}';
  v_frozen text[];
BEGIN
  IF p_id IS NULL OR p_expected_version IS NULL
     OR NOT public.appointment_values_valid(p_starts_at, p_ends_at, p_booking_closes_at,
       p_capacity, p_title, p_venue) THEN
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
  PERFORM public.assert_appointment_manager(v_project, (p_context).staff_user_id, a.kind,
    a.host_staff_user_id);
  IF a.kind = 'consultation' AND p_audience_wave_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF a.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_version';
  END IF;
  IF p_starts_at <> a.starts_at THEN v_fields := v_fields || 'startsAt'::text; END IF;
  IF p_ends_at <> a.ends_at THEN v_fields := v_fields || 'endsAt'::text; END IF;
  IF p_booking_closes_at <> a.booking_closes_at THEN v_fields := v_fields || 'bookingClosesAt'::text; END IF;
  IF p_capacity <> a.capacity THEN v_fields := v_fields || 'capacity'::text; END IF;
  IF p_title IS DISTINCT FROM a.title THEN v_fields := v_fields || 'title'::text; END IF;
  IF p_venue <> a.venue THEN v_fields := v_fields || 'venue'::text; END IF;
  IF p_audience_wave_id IS DISTINCT FROM a.audience_wave_id THEN
    v_fields := v_fields || 'audienceWaveId'::text;
  END IF;
  v_frozen := ARRAY(SELECT f FROM unnest(v_fields) f
                    WHERE f IN ('startsAt', 'endsAt', 'bookingClosesAt', 'audienceWaveId'));
  IF pg_catalog.cardinality(v_frozen) > 0
     AND EXISTS (SELECT FROM public.appointment_booking WHERE appointment_id = p_id) THEN
    RAISE EXCEPTION 'appointment_in_use';
  END IF;
  IF ('startsAt' = ANY (v_fields) OR 'endsAt' = ANY (v_fields)) AND p_starts_at <= now() THEN
    RAISE EXCEPTION 'starts_in_past';
  END IF;
  IF 'audienceWaveId' = ANY (v_fields) THEN
    PERFORM public.assert_appointment_audience(v_project, p_audience_wave_id);
  END IF;
  IF p_capacity < (SELECT pg_catalog.count(*) FROM public.appointment_booking
                   WHERE appointment_id = p_id AND status = 'booked') THEN
    RAISE EXCEPTION 'capacity_below_bookings';
  END IF;
  IF a.kind = 'consultation' AND ('startsAt' = ANY (v_fields) OR 'endsAt' = ANY (v_fields)) THEN
    PERFORM public.assert_host_free(a.host_staff_user_id, p_id, p_starts_at, p_ends_at);
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'appointment_unchanged';
  END IF;
  UPDATE public.appointment SET starts_at = p_starts_at, ends_at = p_ends_at,
    booking_closes_at = p_booking_closes_at, capacity = p_capacity, title = p_title,
    venue = p_venue, audience_wave_id = p_audience_wave_id, version = version + 1
  WHERE id = p_id
  RETURNING * INTO a;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('appointmentId', p_id,
      'version', a.version, 'fields', pg_catalog.to_jsonb(v_fields)), false);
  RETURN a.version;
END $$;
--> statement-breakpoint

-- A slot's new host (Q162: the PL only), before its start, under the exclusive project lock:
-- the participations of its live bookings, the appointment, its bookings. Refuses
-- `invalid_argument`, `actor_not_allowed`, `appointment_not_found`, `not_consultation`,
-- `appointment_cancelled`, `appointment_started`, `stale_version`, `appointment_unchanged`,
-- `host_not_allowed` (not an active PL or consultant of the project), `host_not_responsible` (a
-- live booking the new host may not list) and `host_overlap`. Audited `appointment_changed` with
-- the new host's id; returns the new version.
CREATE FUNCTION change_appointment_host(
  p_context audit_context, p_id uuid, p_expected_version integer, p_host uuid
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  a public.appointment;
BEGIN
  IF p_id IS NULL OR p_expected_version IS NULL OR p_host IS NULL THEN
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
  PERFORM FROM public.appointment_booking WHERE appointment_id = p_id AND status = 'booked'
  ORDER BY id FOR SHARE;
  IF NOT 'project_lead' = ANY (public.appointment_member_roles(v_project,
       (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF a.kind <> 'consultation' THEN
    RAISE EXCEPTION 'not_consultation';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  IF a.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_version';
  END IF;
  IF a.host_staff_user_id = p_host THEN
    RAISE EXCEPTION 'appointment_unchanged';
  END IF;
  IF NOT public.appointment_member_roles(v_project, p_host) && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'host_not_allowed';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking b
             WHERE b.appointment_id = p_id AND b.status = 'booked'
               AND NOT public.appointment_staff_allowed(b.participation_id, p_host)) THEN
    RAISE EXCEPTION 'host_not_responsible';
  END IF;
  PERFORM public.assert_host_free(p_host, p_id, a.starts_at, a.ends_at);
  UPDATE public.appointment SET host_staff_user_id = p_host, version = version + 1
  WHERE id = p_id
  RETURNING * INTO a;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('appointmentId', p_id,
      'version', a.version, 'fields', '["hostStaffUserId"]'::jsonb, 'hostStaffUserId', p_host),
    false);
  RETURN a.version;
END $$;
--> statement-breakpoint

-- The organizer's cancellation (Q164), before or after the start, with a closed reason, under the
-- exclusive project lock: the participations of its live bookings in UUID order, the
-- appointment, its bookings in id order. Every live booking is cancelled `appointment_cancelled`
-- (`appointment_booking_cancelled` in each participation's history), then the appointment
-- (`appointment_cancelled`, project-level). Refuses `invalid_argument`, `actor_not_allowed`,
-- `appointment_not_found`, `appointment_cancelled`. Returns the bookings cancelled.
CREATE FUNCTION cancel_appointment(
  p_context audit_context, p_id uuid, p_reason appointment_cancel_reason
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  a public.appointment;
  b public.appointment_booking;
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
  PERFORM public.assert_appointment_manager(v_project, (p_context).staff_user_id, a.kind,
    a.host_staff_user_id);
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  FOR b IN SELECT * FROM public.appointment_booking
           WHERE appointment_id = p_id AND status = 'booked' ORDER BY id FOR UPDATE LOOP
    PERFORM public.cancel_booking_row(b, a, 'appointment_cancelled', p_context);
    v_count := v_count + 1;
  END LOOP;
  UPDATE public.appointment SET status = 'cancelled', cancel_reason = p_reason,
    cancelled_at = now(), version = version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_cancelled', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('appointmentId', p_id, 'correction', false), false);
  RETURN v_count;
END $$;
--> statement-breakpoint

-- A staff booking (Q164; origin `staff`): the PL or the assigned consultant, in normal mode. Locks
-- the participation (with the shared project lock), then the appointment (capacity, overlaps).
-- Refuses `invalid_argument`, `actor_not_allowed`, `appointment_not_found`,
-- `participation_not_found` (none, or of another project), `project_not_active`, then in the
-- domain's order `appointment_cancelled`, `appointment_started`, `participation_closed`,
-- `not_in_audience`, `host_not_responsible`, `already_booked`, `info_event_limit`,
-- `booking_overlap`, `appointment_full`, `after_cutoff` (`participation_before_cutoff`). Staff
-- book until the start, also after the public cutoff. Audited `appointment_booked` with the
-- appointment's kind and start as written; returns the booking id.
CREATE FUNCTION book_appointment(
  p_context audit_context, p_appointment_id uuid, p_participation_id uuid, p_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  p public.participation;
  a public.appointment;
BEGIN
  IF p_appointment_id IS NULL OR p_participation_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, p_participation_id);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  IF NOT EXISTS (SELECT FROM public.participation
                 WHERE id = p_participation_id AND project_id = v_project) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  p := public.lock_participation(p_participation_id);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF a.kind = 'info_event' AND (
       p.status NOT IN ('imported', 'contacted', 'unreachable', 'informed')
       OR a.audience_wave_id IS NOT NULL AND a.audience_wave_id IS DISTINCT FROM p.entry_wave_id) THEN
    RAISE EXCEPTION 'not_in_audience';
  END IF;
  IF a.kind = 'consultation' AND NOT public.appointment_staff_allowed(p.id, a.host_staff_user_id) THEN
    RAISE EXCEPTION 'host_not_responsible';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking
             WHERE appointment_id = a.id AND participation_id = p.id AND status = 'booked') THEN
    RAISE EXCEPTION 'already_booked';
  END IF;
  IF a.kind = 'info_event' AND EXISTS (
       SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
       WHERE b.participation_id = p.id AND b.status = 'booked' AND x.kind = 'info_event'
         AND x.ends_at > now()) THEN
    RAISE EXCEPTION 'info_event_limit';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
             WHERE b.participation_id = p.id AND b.status = 'booked'
               AND x.starts_at < a.ends_at AND a.starts_at < x.ends_at) THEN
    RAISE EXCEPTION 'booking_overlap';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.appointment_booking
      WHERE appointment_id = a.id AND status = 'booked') >= a.capacity THEN
    RAISE EXCEPTION 'appointment_full';
  END IF;
  IF NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'after_cutoff';
  END IF;
  BEGIN
    INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
      origin, booked_by)
    VALUES (p_id, v_project, p.id, a.id, 'staff', (p_context).staff_user_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('bookingId', p_id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at),
      'origin', 'staff'), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- Staff cancel one live booking until the start (Q164): the PL or the assigned consultant. Locks
-- the participation, the appointment, the booking. Refuses `invalid_argument`,
-- `actor_not_allowed`, `booking_not_found`, `booking_cancelled`, `appointment_started`. Audited
-- `appointment_booking_cancelled` (`staff_cancelled`).
CREATE FUNCTION cancel_appointment_booking(p_context audit_context, p_booking_id uuid)
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
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  PERFORM public.cancel_booking_row(b, a, 'staff_cancelled', p_context);
END $$;
--> statement-breakpoint

-- A terminal status cancels the participation's live bookings of appointments that haven't
-- started (`participation_closed`), in the status function's transaction, as the system; bookings
-- of started appointments stay for the attendance record. The participation row is held; the
-- bookings are locked in id order, the appointments not (a freed seat only lowers a count).
CREATE FUNCTION cancel_bookings_at_terminal_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.appointment_booking;
  a public.appointment;
BEGIN
  IF NEW.status IN ('withdrawn', 'ta_completed', 'exited')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR b IN SELECT bk.* FROM public.appointment_booking bk
             JOIN public.appointment x ON x.id = bk.appointment_id
             WHERE bk.participation_id = NEW.id AND bk.status = 'booked' AND x.starts_at > now()
             ORDER BY bk.id FOR UPDATE OF bk LOOP
      SELECT * INTO a FROM public.appointment WHERE id = b.appointment_id;
      PERFORM public.cancel_booking_row(b, a, 'participation_closed',
        ROW('system', NULL, NULL, 'terminal-booking-cancellation', NULL, NULL, NULL)::public.audit_context);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER participation_terminal_cancel_bookings AFTER UPDATE OF status ON participation
FOR EACH ROW EXECUTE FUNCTION cancel_bookings_at_terminal_status();
--> statement-breakpoint

-- Replaced: the appointment events are written only by their functions too.
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
      'appointment_booking_cancelled') THEN
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

-- Grants: transfer_app selects the appointments and bookings and writes neither.
GRANT SELECT ON TABLE appointment, appointment_booking TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION appointment_member_roles, appointment_staff_allowed,
  appointment_text_valid, appointment_instant, appointment_values_valid, assert_host_free,
  assert_appointment_audience, assert_appointment_manager, assert_appointment_context,
  cancel_booking_row, lock_appointment_participations, cancel_bookings_at_terminal_status,
  create_appointment, update_appointment, change_appointment_host, cancel_appointment,
  book_appointment, cancel_appointment_booking FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_appointment, update_appointment, change_appointment_host,
  cancel_appointment, book_appointment, cancel_appointment_booking TO transfer_app;
