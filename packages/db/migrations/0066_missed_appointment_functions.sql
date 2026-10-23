-- Hand-written (ADR-0002, appointments; process-and-lifecycle.md, appointments: the work list;
-- Q167): a missed appointment's explicit resolution, a consultation booked as the follow-up of a
-- missed one, the history's projection rows and the grants. Same hardening as 0064: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. Audit details carry ids, codes and times only. The new enum values of 0065
-- are compared as text here, since this runs after them in the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock shared through `lock_participation`, the
-- participation row, the appointment, then booking rows.

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
    'attendance_conflict_escalated', 'attendance_conflict_resolved',
    'appointment_notice_followed_up', 'missed_appointment_resolved'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a booking names the missed
-- booking it follows up; the resolution shows its reason and the appointment as written.
UPDATE audit_event_projection
SET detail_keys = '{appointmentId,appointmentKind,startsAt,origin,followUpOf}'
WHERE event_type = 'appointment_booked';
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('missed_appointment_resolved', NULL, 'case', false, true,
   '{appointmentId,appointmentKind,startsAt}');
--> statement-breakpoint

-- Internal helper (no grant). Whether a booking is a missed appointment now (the domain's
-- `missedBookings`): live, recorded `absent`, not a basis of `informed` (its conflict covers it),
-- no explicit resolution, and no live follow-up: for an info event a later info-event booking of
-- the participation (matched automatically), for a consultation a booking linked by
-- `follow_up_of`. A follow-up recorded `absent` is missed itself, so a chain has one item.
-- Never null (an unrecorded booking is no missed one).
CREATE FUNCTION booking_missed(b appointment_booking)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT b.status = 'booked' AND b.attendance IS NOT DISTINCT FROM 'absent'
    AND b.informed_basis_at IS NULL
    AND b.missed_resolution IS NULL
    AND EXISTS (SELECT FROM public.appointment a WHERE a.id = b.appointment_id
                AND a.status = 'scheduled')
    AND NOT EXISTS (
      SELECT FROM public.appointment a
      JOIN public.appointment_booking f ON f.participation_id = b.participation_id
        AND f.id <> b.id AND f.status = 'booked'
      JOIN public.appointment x ON x.id = f.appointment_id AND x.status = 'scheduled'
      WHERE a.id = b.appointment_id
        AND CASE WHEN a.kind = 'consultation' THEN f.follow_up_of = b.id
                 ELSE x.kind = 'info_event' AND x.starts_at > a.starts_at END)
$$;
--> statement-breakpoint

-- "Keine weitere Nachverfolgung" (Q167): the PL or the assigned consultant in normal mode ends a
-- missed appointment's chain with a closed reason, once, while the participation is open (a
-- terminal one has no missed item). Locks the participation (shared project lock), the
-- appointment `FOR SHARE`, the booking. Refuses `invalid_argument`, `actor_not_allowed`,
-- `booking_not_found`, `participation_closed`, `already_resolved`, `not_missed`. Audited
-- `missed_appointment_resolved` with the reason and the appointment as written.
CREATE FUNCTION resolve_missed_appointment(
  p_context audit_context, p_booking_id uuid, p_reason missed_resolution
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation uuid;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.appointment_booking
  WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT x.* INTO a FROM public.appointment x WHERE x.id = (
    SELECT appointment_id FROM public.appointment_booking WHERE id = p_booking_id) FOR SHARE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF b.missed_resolution IS NOT NULL THEN
    RAISE EXCEPTION 'already_resolved';
  END IF;
  IF NOT public.booking_missed(b) THEN
    RAISE EXCEPTION 'not_missed';
  END IF;
  UPDATE public.appointment_booking SET missed_resolution = p_reason,
    missed_resolved_by = (p_context).staff_user_id, missed_resolved_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'missed_appointment_resolved', p_context, NULL, NULL, NULL, p_reason::text, NULL,
    public.booking_event_details(b, a), false);
END $$;
--> statement-breakpoint

-- Replaced (Q167): staff may book a consultation as the follow-up of the participation's missed
-- consultation (`p_follow_up_of`, its booking; an info event's follow-up is matched
-- automatically). After the booking rules, refuses `follow_up_not_found` (not a booking of this
-- participation), `follow_up_kind_mismatch` (either isn't a consultation) and
-- `follow_up_not_missed` (not a missed appointment now: attended, resolved, or followed up by a
-- live booking already); the followed booking is locked after the appointment. The participant
-- links nothing (`invalid_argument`). `appointment_booked` names `followUpOf`. Otherwise
-- unchanged (0064).
DROP FUNCTION book_appointment(audit_context, uuid, uuid, uuid, text);
--> statement-breakpoint
CREATE FUNCTION book_appointment(
  p_context audit_context, p_appointment_id uuid, p_participation_id uuid, p_id uuid,
  p_token_hash text DEFAULT NULL, p_follow_up_of uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participant boolean := (p_context).actor_type = 'participant';
  v_project uuid;
  v_refusal text;
  s public.participant_session;
  p public.participation;
  a public.appointment;
  f public.appointment_booking;
  v_followed_kind text;
BEGIN
  IF p_appointment_id IS NULL OR p_participation_id IS NULL OR p_id IS NULL
     OR coalesce(v_participant, false) = (p_token_hash IS NULL)
     OR v_participant AND p_follow_up_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_participant THEN
    PERFORM public.assert_context(p_context, p_participation_id, '{participant}');
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    IF v_project IS DISTINCT FROM s.project_id THEN
      RAISE EXCEPTION 'appointment_not_found';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
    SELECT * INTO p FROM public.participation WHERE id = s.participation_id;
  ELSE
    PERFORM public.assert_appointment_context(p_context, p_participation_id);
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
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  v_refusal := public.appointment_booking_refusal(p, a, v_participant);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = v_refusal;
  END IF;
  IF p_follow_up_of IS NOT NULL THEN
    SELECT * INTO f FROM public.appointment_booking
    WHERE id = p_follow_up_of AND participation_id = p.id FOR UPDATE;
    IF f.id IS NULL THEN
      RAISE EXCEPTION 'follow_up_not_found';
    END IF;
    SELECT kind::text INTO v_followed_kind FROM public.appointment WHERE id = f.appointment_id;
    IF a.kind <> 'consultation' OR v_followed_kind <> 'consultation' THEN
      RAISE EXCEPTION 'follow_up_kind_mismatch';
    END IF;
    IF NOT public.booking_missed(f) THEN
      RAISE EXCEPTION 'follow_up_not_missed';
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
      origin, booked_by, follow_up_of)
    VALUES (p_id, v_project, p.id, a.id,
      CASE WHEN v_participant THEN 'participant' ELSE 'staff' END::public.booking_origin,
      (p_context).staff_user_id, p_follow_up_of);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('bookingId', p_id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at),
      'origin', CASE WHEN v_participant THEN 'participant' ELSE 'staff' END,
      'followUpOf', p_follow_up_of), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- Replaced: the resolution's event is written only by its function too.
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
      'attendance_conflict_resolved', 'appointment_notice_followed_up',
      'missed_appointment_resolved') THEN
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

REVOKE ALL ON FUNCTION booking_missed, resolve_missed_appointment, book_appointment FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_missed_appointment, book_appointment TO transfer_app;
