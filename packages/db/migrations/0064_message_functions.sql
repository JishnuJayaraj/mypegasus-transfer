-- Hand-written (ADR-0002, appointments and messages; ADR-0011; data-protection.md, messages and
-- appointments: the portal; Q164, Q165, Q168): the participant's own booking and cancellation,
-- invitations, the organizer's notices, the dispatch claim for the new kinds, a notice's follow-up,
-- the history's projection rows and the grants. Same hardening as 0062: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. Audit details carry ids, codes and times only: never an address, a text, the title or
-- the venue. The new enum values of 0063 are compared as text here, since this runs after them in
-- the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock first, shared through `lock_participation`
-- for one participation, exclusive for several or an appointment's bookings; then participation
-- rows in UUID order → the appointment row → booking rows in id order → message rows → channel and
-- consent rows (`FOR SHARE`). The dispatch claim: participation → appointment and booking
-- `FOR SHARE` → message `FOR UPDATE` → channel, consent `FOR SHARE`.

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
    'appointment_notice_followed_up'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a message's kind and
-- appointment in both the queued and the delivery projection (Q168); older events lack them.
UPDATE audit_event_projection SET detail_keys = '{kind,channelKind,appointmentId,startsAt}'
WHERE event_type = 'reminder_queued';
--> statement-breakpoint
UPDATE audit_event_projection SET detail_keys = '{outcome,kind,appointmentId}'
WHERE event_type = 'reminder_delivery';
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('appointment_notice_followed_up', NULL, 'case', false, false, '{method,appointmentId}');
--> statement-breakpoint

-- Internal helpers (no grant).

-- The system context of the organizer's notices: queued as the system in the organizer's own
-- transaction (correlated with its request), never by a requester's authority.
CREATE FUNCTION appointment_notice_context(p_request_id text)
RETURNS audit_context LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ROW('system', NULL, NULL, 'appointments.notify', NULL, p_request_id, NULL)::public.audit_context
$$;
--> statement-breakpoint

-- The context a message's job records its outcome in: `appointments.notify` for a notice,
-- `reminders.send` otherwise.
CREATE FUNCTION message_job_context(r participant_reminder, p_job_id text)
RETURNS audit_context LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ROW('system', NULL, NULL,
    CASE WHEN r.kind::text IN ('appointment_changed', 'appointment_cancelled')
         THEN 'appointments.notify' ELSE 'reminders.send' END,
    NULL, NULL, p_job_id)::public.audit_context
$$;
--> statement-breakpoint

-- Whether the participation may book the appointment now, as the participant (until the public
-- cutoff) or staff (until the start): the first refusal in the domain's order
-- (`bookingEligibility`), or null. The caller holds the participation and the appointment.
CREATE FUNCTION appointment_booking_refusal(p participation, a appointment, p_participant boolean)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF a.status = 'cancelled' THEN RETURN 'appointment_cancelled'; END IF;
  IF a.starts_at <= now() THEN RETURN 'appointment_started'; END IF;
  IF p_participant AND a.booking_closes_at <= now() THEN RETURN 'booking_closed'; END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN RETURN 'participation_closed'; END IF;
  IF a.kind = 'info_event' AND (
       p.status NOT IN ('imported', 'contacted', 'unreachable', 'informed')
       OR a.audience_wave_id IS NOT NULL AND a.audience_wave_id IS DISTINCT FROM p.entry_wave_id) THEN
    RETURN 'not_in_audience';
  END IF;
  IF a.kind = 'consultation' AND NOT public.appointment_staff_allowed(p.id, a.host_staff_user_id) THEN
    RETURN 'host_not_responsible';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking
             WHERE appointment_id = a.id AND participation_id = p.id AND status = 'booked') THEN
    RETURN 'already_booked';
  END IF;
  IF a.kind = 'info_event' AND EXISTS (
       SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
       WHERE b.participation_id = p.id AND b.status = 'booked' AND x.kind = 'info_event'
         AND x.ends_at > now()) THEN
    RETURN 'info_event_limit';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking b JOIN public.appointment x ON x.id = b.appointment_id
             WHERE b.participation_id = p.id AND b.status = 'booked'
               AND x.starts_at < a.ends_at AND a.starts_at < x.ends_at) THEN
    RETURN 'booking_overlap';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.appointment_booking
      WHERE appointment_id = a.id AND status = 'booked') >= a.capacity THEN
    RETURN 'appointment_full';
  END IF;
  IF NOT public.participation_before_cutoff(p) THEN RETURN 'after_cutoff'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- An appointment's message for one participation (data-protection.md, messages), fixed when
-- queued: the channel (the most recently verified live email with a live consent v2, else
-- mobile; the smaller id on a tie), its consent, the account's language (German without an
-- account) and the text version of the kind. Without a usable channel the row is `cancelled` at
-- once (`no_channel`: no live channel; `consent_required`: none with a live consent v2), so the
-- portal shows it either way and no job runs. Audited `reminder_queued` (and, cancelled at once,
-- `reminder_delivery`) in `p_context`: the requester for an invitation, the system for a notice.
CREATE FUNCTION queue_appointment_message(
  p participation, a appointment, p_kind reminder_kind, p_booking_id uuid, p_batch_id uuid,
  p_context audit_context
) RETURNS participant_reminder LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ch record;
  r public.participant_reminder;
  v_reason public.reminder_cancel_reason;
BEGIN
  SELECT c.id, c.kind, c.consent_id INTO ch
  FROM public.participant_channel c
  JOIN public.consent_record k ON k.id = c.consent_id
  WHERE c.participation_id = p.id AND c.removed_at IS NULL AND c.suspended_at IS NULL
    AND k.purpose = 'portal_contact' AND k.text_version = 'portal-contact-consent:v2'
    AND k.ended_at IS NULL
  ORDER BY c.kind = 'email' DESC, c.verified_at DESC, c.id
  LIMIT 1;
  IF NOT FOUND THEN
    v_reason := CASE WHEN EXISTS (SELECT FROM public.participant_channel c
                                  WHERE c.participation_id = p.id AND c.removed_at IS NULL
                                    AND c.suspended_at IS NULL)
                     THEN 'consent_required' ELSE 'no_channel' END;
  END IF;
  INSERT INTO public.participant_reminder (id, project_id, participation_id, batch_id, kind,
    message_version, language, channel_id, channel_kind, consent_id, requested_by, requested_on,
    status, cancel_reason, outcome_at, appointment_id, booking_id)
  VALUES (gen_random_uuid(), p.project_id, p.id, p_batch_id, p_kind,
    CASE WHEN p_kind::text = 'appointment_invitation' THEN 'portal-invitation:v1'
         ELSE 'portal-appointment-change:v1' END,
    coalesce((SELECT language FROM public.participant_account WHERE participation_id = p.id), 'de'),
    ch.id, ch.kind, ch.consent_id, (p_context).staff_user_id,
    (now() AT TIME ZONE 'Europe/Berlin')::date,
    CASE WHEN v_reason IS NULL THEN 'queued' ELSE 'cancelled' END::public.reminder_status,
    v_reason, CASE WHEN v_reason IS NOT NULL THEN now() END, a.id, p_booking_id)
  RETURNING * INTO r;
  PERFORM public.write_audit_event(p.project_id, p.id, 'reminder_queued', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('reminderId', r.id, 'batchId', p_batch_id,
      'kind', p_kind, 'channelKind', ch.kind, 'appointmentId', a.id,
      'startsAt', public.appointment_instant(a.starts_at)), false);
  IF v_reason IS NOT NULL THEN
    PERFORM public.write_audit_event(p.project_id, p.id, 'reminder_delivery', p_context, NULL,
      NULL, NULL, v_reason::text, NULL, pg_catalog.jsonb_build_object('reminderId', r.id,
        'outcome', 'cancelled', 'kind', p_kind, 'appointmentId', a.id), false);
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- The organizer's notice (Q165) to the person of one booking, queued as the system in the
-- organizer's transaction, so a reassignment before the dispatch can't suppress it. None for a
-- closed participation. The caller holds the participation, the appointment and the booking.
CREATE FUNCTION queue_appointment_notice(
  b appointment_booking, a appointment, p_kind reminder_kind, p_batch_id uuid,
  p_context audit_context
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.participation;
BEGIN
  SELECT * INTO p FROM public.participation WHERE id = b.participation_id;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN RETURN; END IF;
  PERFORM public.queue_appointment_message(p, a, p_kind, b.id, p_batch_id,
    public.appointment_notice_context((p_context).request_id));
END $$;
--> statement-breakpoint

-- Replaced: a message's final state with its `reminder_delivery` event, now with its kind and
-- appointment (Q168) and in its job's context. The caller holds the message's row lock.
CREATE OR REPLACE FUNCTION settle_reminder(
  r participant_reminder, p_status reminder_status, p_cancel_reason reminder_cancel_reason,
  p_job_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.participant_reminder SET status = p_status, cancel_reason = p_cancel_reason,
    outcome_at = now()
  WHERE id = r.id;
  PERFORM public.write_audit_event(r.project_id, r.participation_id, 'reminder_delivery',
    public.message_job_context(r, p_job_id), NULL, NULL, NULL, p_cancel_reason::text, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('reminderId', r.id,
      'outcome', p_status, 'kind', r.kind, 'appointmentId', r.appointment_id)), false);
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- Replaced (data-protection.md, messages): only reminders (`open_items`) count the 3-day window;
-- invitations and notices neither use nor consume it, and this function queues reminders only.
-- Otherwise unchanged (0056).
CREATE OR REPLACE FUNCTION request_reminders(
  p_context audit_context, p_project_id uuid, p_participation_ids uuid[], p_kind reminder_kind,
  p_message_version text, p_batch_id uuid
) RETURNS TABLE (participation_id uuid, reminder_id uuid, channel_kind contact_channel_kind,
  skip text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_staff uuid := (p_context).staff_user_id;
  v_roles text[];
  v_today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_id uuid;
  p public.participation;
  ch record;
  v_reminder uuid;
BEGIN
  IF p_project_id IS NULL OR p_kind IS DISTINCT FROM 'open_items' OR p_batch_id IS NULL
     OR p_message_version IS DISTINCT FROM 'portal-reminder:v1'
     OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM unnest(p_participation_ids) x)
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM public.lock_project_setup(p_project_id);
  IF EXISTS (SELECT FROM unnest(p_participation_ids) x
             WHERE NOT EXISTS (SELECT FROM public.participation q
                               WHERE q.id = x AND q.project_id = p_project_id)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  v_roles := public.appointment_member_roles(p_project_id, v_staff);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF NOT 'project_lead' = ANY (v_roles) AND EXISTS (
    SELECT FROM unnest(p_participation_ids) x
    WHERE NOT EXISTS (SELECT FROM public.participant_assignment a
                      WHERE a.participation_id = x AND a.staff_user_id = v_staff
                        AND a.ended_at IS NULL)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (SELECT status FROM public.project WHERE id = p_project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;

  FOREACH v_id IN ARRAY p_participation_ids LOOP
    p := public.lock_participation(v_id);
    participation_id := v_id;
    reminder_id := NULL;
    channel_kind := NULL;
    skip := NULL;
    IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
      skip := 'participation_closed';
    ELSIF NOT EXISTS (SELECT FROM public.participant_channel c
                      WHERE c.participation_id = v_id AND c.removed_at IS NULL
                        AND c.suspended_at IS NULL) THEN
      skip := 'no_channel';
    ELSE
      SELECT c.id, c.kind, c.consent_id INTO ch
      FROM public.participant_channel c
      JOIN public.consent_record k ON k.id = c.consent_id
      WHERE c.participation_id = v_id AND c.removed_at IS NULL AND c.suspended_at IS NULL
        AND k.purpose = 'portal_contact' AND k.text_version = 'portal-contact-consent:v2'
        AND k.ended_at IS NULL
      ORDER BY c.kind = 'email' DESC, c.verified_at DESC, c.id
      LIMIT 1;
      IF NOT FOUND THEN
        skip := 'consent_required';
      ELSIF EXISTS (SELECT FROM public.participant_reminder r
                    WHERE r.participation_id = v_id AND r.kind = 'open_items'
                      AND r.requested_on > v_today - 3) THEN
        skip := 'reminded_recently';
      ELSE
        v_reminder := gen_random_uuid();
        INSERT INTO public.participant_reminder (id, project_id, participation_id, batch_id, kind,
          message_version, language, channel_id, channel_kind, consent_id, requested_by,
          requested_on)
        SELECT v_reminder, p.project_id, v_id, p_batch_id, p_kind, p_message_version, a.language,
          ch.id, ch.kind, ch.consent_id, v_staff, v_today
        FROM public.participant_account a WHERE a.participation_id = v_id;
        PERFORM public.write_audit_event(p.project_id, v_id, 'reminder_queued', p_context, NULL,
          NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('reminderId', v_reminder,
            'batchId', p_batch_id, 'kind', p_kind, 'channelKind', ch.kind), false);
        reminder_id := v_reminder;
        channel_kind := ch.kind;
      END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint

-- Invitations to an appointment (data-protection.md, invitations; Q165): a PL of the project or
-- the assigned consultant, in normal mode, for 1–500 distinct participations of the active
-- project, under the exclusive project lock: the participations in UUID order, then the
-- appointment. Refused as a whole: `invalid_argument`, `actor_not_allowed` (another role,
-- assisted mode), `appointment_not_found`, `participation_not_found` (another project's id, or for
-- a consultant one not assigned to them), `project_not_active`, and an appointment no one can
-- book from the portal now (`appointment_cancelled`, `appointment_started`, `booking_closed`,
-- `appointment_full`). Per row, in order: `participation_closed`; `not_eligible` (another booking
-- rule for the participant); `already_booked`; `already_invited` (the latest invitation is still
-- open, its outcome uncertain or `sent`, or cancelled for a reason other than delivery or
-- `requester_no_longer_authorized`); `invitation_limit` (three delivery attempts: rows handed to a
-- provider). Otherwise an invitation, also without a usable channel (`not_deliverable`: cancelled
-- at once). The 3-day reminder window plays no part. Returns one row per participation.
CREATE FUNCTION request_invitations(
  p_context audit_context, p_appointment_id uuid, p_participation_ids uuid[], p_batch_id uuid
) RETURNS TABLE (participation_id uuid, reminder_id uuid, channel_kind contact_channel_kind,
  not_deliverable text, skip text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_staff uuid := (p_context).staff_user_id;
  v_project uuid;
  v_roles text[];
  v_id uuid;
  v_refusal text;
  p public.participation;
  a public.appointment;
  r public.participant_reminder;
  latest public.participant_reminder;
BEGIN
  IF p_appointment_id IS NULL OR p_batch_id IS NULL OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM unnest(p_participation_ids) x)
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  IF EXISTS (SELECT FROM unnest(p_participation_ids) x
             WHERE NOT EXISTS (SELECT FROM public.participation q
                               WHERE q.id = x AND q.project_id = v_project)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  v_roles := public.appointment_member_roles(v_project, v_staff);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF NOT 'project_lead' = ANY (v_roles) AND EXISTS (
    SELECT FROM unnest(p_participation_ids) x
    WHERE NOT EXISTS (SELECT FROM public.participant_assignment s
                      WHERE s.participation_id = x AND s.staff_user_id = v_staff
                        AND s.ended_at IS NULL)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  PERFORM FROM public.participation WHERE id = ANY (p_participation_ids) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  IF a.status = 'cancelled' THEN RAISE EXCEPTION 'appointment_cancelled'; END IF;
  IF a.starts_at <= now() THEN RAISE EXCEPTION 'appointment_started'; END IF;
  IF a.booking_closes_at <= now() THEN RAISE EXCEPTION 'booking_closed'; END IF;
  IF (SELECT pg_catalog.count(*) FROM public.appointment_booking
      WHERE appointment_id = a.id AND status = 'booked') >= a.capacity THEN
    RAISE EXCEPTION 'appointment_full';
  END IF;

  FOREACH v_id IN ARRAY p_participation_ids LOOP
    SELECT * INTO p FROM public.participation WHERE id = v_id;
    participation_id := v_id;
    reminder_id := NULL;
    channel_kind := NULL;
    not_deliverable := NULL;
    skip := NULL;
    v_refusal := public.appointment_booking_refusal(p, a, true);
    SELECT * INTO latest FROM public.participant_reminder x
    WHERE x.participation_id = v_id AND x.appointment_id = a.id
      AND x.kind::text = 'appointment_invitation'
    ORDER BY x.requested_at DESC, x.id DESC LIMIT 1;
    IF v_refusal = 'participation_closed' THEN
      skip := 'participation_closed';
    ELSIF v_refusal = 'already_booked' THEN
      skip := 'already_booked';
    ELSIF v_refusal IS NOT NULL THEN
      skip := 'not_eligible';
    ELSIF latest.id IS NOT NULL AND NOT (latest.status = 'failed' OR latest.status = 'cancelled'
          AND latest.cancel_reason::text IN ('no_channel', 'consent_required',
            'channel_unavailable', 'consent_ended', 'delivery_unavailable',
            'requester_no_longer_authorized')) THEN
      skip := 'already_invited';
    ELSIF (SELECT pg_catalog.count(*) FROM public.participant_reminder x
           WHERE x.participation_id = v_id AND x.appointment_id = a.id
             AND x.kind::text = 'appointment_invitation'
             AND x.status IN ('sent', 'failed', 'delivery_unknown')) >= 3 THEN
      skip := 'invitation_limit';
    ELSE
      r := public.queue_appointment_message(p, a, 'appointment_invitation', NULL, p_batch_id,
        p_context);
      reminder_id := r.id;
      channel_kind := r.channel_kind;
      not_deliverable := r.cancel_reason::text;
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint

-- Replaced (data-protection.md, reminders and messages): the dispatch claim for every kind, in the
-- one lock order: the participation (shared project lock), the appointment and the booking
-- `FOR SHARE` (their ids read from the message's immutable columns without a lock), the message
-- `FOR UPDATE`, its channel and consent `FOR SHARE`. It rechecks the participation open
-- (`participation_closed`), the channel live and still on that consent (`channel_unavailable`),
-- the consent live, of the portal contact purpose and v2 (`consent_ended`); for a reminder and an
-- invitation the requester still PL or the assigned consultant (`requester_no_longer_authorized`);
-- for a reminder something open (`nothing_open`, `p_has_actions`); for an invitation not booked
-- meanwhile (`nothing_open`) and still bookable for the participant (`appointment_unavailable`).
-- An organizer's notice has no requester check. A queued message that fails is cancelled with
-- that reason and the reason returned; one already `dispatching` (a retry after an unknown
-- outcome) ends `delivery_unknown` (`settled`). Otherwise it becomes `dispatching` (returned). A
-- message already final returns `settled`.
CREATE OR REPLACE FUNCTION claim_reminder_dispatch(p_reminder_id uuid, p_has_actions boolean, p_job_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participant_reminder;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
  ch public.participant_channel;
  k public.consent_record;
  v_refusal text;
  v_reason public.reminder_cancel_reason;
BEGIN
  IF p_reminder_id IS NULL OR p_has_actions IS NULL OR p_job_id IS NULL
     OR p_job_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  p := public.lock_participation(r.participation_id);
  IF r.appointment_id IS NOT NULL THEN
    SELECT * INTO a FROM public.appointment WHERE id = r.appointment_id FOR SHARE;
  END IF;
  IF r.booking_id IS NOT NULL THEN
    SELECT * INTO b FROM public.appointment_booking WHERE id = r.booking_id FOR SHARE;
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF r.status NOT IN ('queued', 'dispatching') THEN
    RETURN 'settled';
  END IF;
  SELECT * INTO ch FROM public.participant_channel WHERE id = r.channel_id FOR SHARE;
  SELECT * INTO k FROM public.consent_record WHERE id = r.consent_id FOR SHARE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    v_reason := 'participation_closed';
  ELSIF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL THEN
    v_reason := 'channel_unavailable';
  ELSIF ch.consent_id <> r.consent_id OR k.ended_at IS NOT NULL OR k.purpose <> 'portal_contact'
        OR k.text_version <> 'portal-contact-consent:v2' THEN
    v_reason := 'consent_ended';
  ELSIF r.requested_by IS NOT NULL
        AND NOT public.reminder_requester_allowed(r.participation_id, r.requested_by) THEN
    v_reason := 'requester_no_longer_authorized';
  ELSIF r.kind = 'open_items' AND NOT p_has_actions THEN
    v_reason := 'nothing_open';
  ELSIF r.kind::text = 'appointment_invitation' THEN
    v_refusal := public.appointment_booking_refusal(p, a, true);
    IF v_refusal = 'already_booked' THEN
      v_reason := 'nothing_open';
    ELSIF v_refusal IS NOT NULL THEN
      v_reason := 'appointment_unavailable';
    END IF;
  ELSIF r.kind::text = 'appointment_cancelled' AND b.status <> 'cancelled' THEN
    -- Never a cancellation notice for a booking that wasn't cancelled.
    RAISE EXCEPTION 'booking_not_cancelled';
  END IF;
  IF v_reason IS NULL THEN
    UPDATE public.participant_reminder SET status = 'dispatching', claimed_at = now()
    WHERE id = r.id;
    RETURN 'dispatching';
  END IF;
  IF r.status = 'dispatching' THEN
    PERFORM public.settle_reminder(r, 'delivery_unknown', NULL, p_job_id);
    RETURN 'settled';
  END IF;
  PERFORM public.settle_reminder(r, 'cancelled', v_reason, p_job_id);
  RETURN v_reason::text;
END $$;
--> statement-breakpoint

-- Replaced (Q164; data-protection.md, appointments: the portal): staff book (origin `staff`, until
-- the start, also after the public cutoff) or the participant books through their live active
-- session (`p_token_hash`, origin `participant`, until the public cutoff). Staff: the PL or the
-- assigned consultant in normal mode; the participation locked (shared project lock), then the
-- appointment. The participant: their session's participation locked, then the session, then the
-- appointment; an appointment of another project is `appointment_not_found`, a dead session
-- `session_invalid`. Refuses `invalid_argument`, `actor_not_allowed`, `appointment_not_found`,
-- `participation_not_found`, `project_not_active`, then in the domain's order
-- `appointment_cancelled`, `appointment_started`, `booking_closed` (the participant),
-- `participation_closed`, `not_in_audience`, `host_not_responsible`, `already_booked`,
-- `info_event_limit`, `booking_overlap`, `appointment_full`, `after_cutoff`. Audited
-- `appointment_booked` with the appointment's kind and start as written; returns the booking id.
DROP FUNCTION book_appointment(audit_context, uuid, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION book_appointment(
  p_context audit_context, p_appointment_id uuid, p_participation_id uuid, p_id uuid,
  p_token_hash text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participant boolean := (p_context).actor_type = 'participant';
  v_project uuid;
  v_refusal text;
  s public.participant_session;
  p public.participation;
  a public.appointment;
BEGIN
  IF p_appointment_id IS NULL OR p_participation_id IS NULL OR p_id IS NULL
     OR coalesce(v_participant, false) = (p_token_hash IS NULL) THEN
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
  BEGIN
    INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
      origin, booked_by)
    VALUES (p_id, v_project, p.id, a.id,
      CASE WHEN v_participant THEN 'participant' ELSE 'staff' END::public.booking_origin,
      (p_context).staff_user_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('bookingId', p_id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at),
      'origin', CASE WHEN v_participant THEN 'participant' ELSE 'staff' END), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- Replaced (Q164, Q165): one live booking cancelled until the start, without attendance recorded.
-- Staff (the PL or the assigned consultant): `staff_cancelled`, and the person gets the
-- organizer's notice (the system's, in this transaction). The participant through their live
-- active session (`p_token_hash`): their own booking only (another one is `booking_not_found`),
-- `participant_cancelled`, no notice. Locks the participation (shared project lock; the
-- participant's session after it), the appointment, the booking. Refuses `invalid_argument`,
-- `actor_not_allowed`, `session_invalid`, `booking_not_found`, `booking_cancelled`,
-- `attendance_recorded`, `appointment_started`.
DROP FUNCTION cancel_appointment_booking(audit_context, uuid);
--> statement-breakpoint
CREATE FUNCTION cancel_appointment_booking(
  p_context audit_context, p_booking_id uuid, p_token_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participant boolean := (p_context).actor_type = 'participant';
  v_participation uuid;
  v_appointment uuid;
  s public.participant_session;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL OR coalesce(v_participant, false) = (p_token_hash IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, appointment_id INTO v_participation, v_appointment
  FROM public.appointment_booking WHERE id = p_booking_id;
  IF v_participant THEN
    PERFORM public.assert_context(p_context, (p_context).participation_id, '{participant}');
    IF v_participation IS DISTINCT FROM (p_context).participation_id THEN
      RAISE EXCEPTION 'booking_not_found';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> v_participation THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  ELSE
    IF v_participation IS NULL THEN
      RAISE EXCEPTION 'booking_not_found';
    END IF;
    PERFORM public.assert_appointment_context(p_context, v_participation);
    p := public.lock_participation(v_participation);
    IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
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
  IF v_participant THEN
    PERFORM public.cancel_booking_row(b, a, 'participant_cancelled', p_context);
  ELSE
    PERFORM public.cancel_booking_row(b, a, 'staff_cancelled', p_context);
    PERFORM public.queue_appointment_notice(b, a, 'appointment_cancelled', gen_random_uuid(),
      p_context);
  END IF;
END $$;
--> statement-breakpoint

-- Replaced (Q164, Q165, Q170): an invitation puts the appointment in use too (its times, cutoff
-- and audience frozen, even once cancelled); a corrected title or venue of an appointment that
-- hasn't started notifies each person with a live booking (the organizer's notice, as the
-- system, in this transaction). Otherwise unchanged (0060).
CREATE OR REPLACE FUNCTION update_appointment(
  p_context audit_context, p_id uuid, p_expected_version integer, p_starts_at timestamptz,
  p_ends_at timestamptz, p_booking_closes_at timestamptz, p_capacity integer, p_title text,
  p_venue text, p_audience_wave_id uuid
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project uuid;
  a public.appointment;
  b public.appointment_booking;
  v_fields text[] := '{}';
  v_frozen text[];
  v_batch uuid := gen_random_uuid();
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
     AND (EXISTS (SELECT FROM public.appointment_booking WHERE appointment_id = p_id)
          OR EXISTS (SELECT FROM public.participant_reminder
                     WHERE appointment_id = p_id AND kind::text = 'appointment_invitation')) THEN
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
  IF v_fields && '{title,venue}'::text[] AND a.starts_at > now() THEN
    FOR b IN SELECT * FROM public.appointment_booking
             WHERE appointment_id = p_id AND status = 'booked' ORDER BY id FOR SHARE LOOP
      PERFORM public.queue_appointment_notice(b, a, 'appointment_changed', v_batch, p_context);
    END LOOP;
  END IF;
  RETURN a.version;
END $$;
--> statement-breakpoint

-- Replaced (Q164, Q165): the organizer's cancellation notifies each person whose booking it
-- cancelled (as the system, in this transaction), also after the start; the PL's
-- `did_not_take_place` correction of a past event over absences only sends none. Otherwise
-- unchanged (0062).
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
  v_batch uuid := gen_random_uuid();
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
    IF NOT v_correction THEN
      PERFORM public.queue_appointment_notice(b, a, 'appointment_cancelled', v_batch, p_context);
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

-- The follow-up of an organizer's notice that wasn't delivered (data-protection.md, messages:
-- follow-up): the PL or the assigned consultant in normal mode records how the person was told
-- (`phone`, `in_person`, `letter`) or that it isn't needed (`not_needed`), once. Locks the
-- participation (shared project lock), then the message. Refuses `invalid_argument`,
-- `actor_not_allowed`, `reminder_not_found` (none, or not a notice), `participation_closed`,
-- `notice_delivered` (sent, still open, or cancelled `participation_closed`),
-- `already_followed_up`. Audited `appointment_notice_followed_up`.
CREATE FUNCTION record_notice_follow_up(
  p_context audit_context, p_reminder_id uuid, p_method notice_follow_up_method
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation uuid;
  p public.participation;
  r public.participant_reminder;
BEGIN
  IF p_reminder_id IS NULL OR p_method IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.participant_reminder
  WHERE id = p_reminder_id AND kind::text IN ('appointment_changed', 'appointment_cancelled');
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF NOT (r.status IN ('failed', 'delivery_unknown')
          OR r.status = 'cancelled' AND r.cancel_reason <> 'participation_closed') THEN
    RAISE EXCEPTION 'notice_delivered';
  END IF;
  IF r.followed_up_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_followed_up';
  END IF;
  UPDATE public.participant_reminder SET followed_up_method = p_method,
    followed_up_by = (p_context).staff_user_id, followed_up_at = now()
  WHERE id = r.id;
  PERFORM public.write_audit_event(r.project_id, r.participation_id,
    'appointment_notice_followed_up', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('reminderId', r.id, 'appointmentId', r.appointment_id,
      'method', p_method), false);
END $$;
--> statement-breakpoint

-- Replaced: the follow-up event is written only by its function too.
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
      'attendance_conflict_resolved', 'appointment_notice_followed_up') THEN
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

REVOKE ALL ON FUNCTION appointment_notice_context, message_job_context,
  appointment_booking_refusal, queue_appointment_message, queue_appointment_notice,
  request_invitations, book_appointment, cancel_appointment_booking, record_notice_follow_up
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION request_invitations, book_appointment, cancel_appointment_booking,
  record_notice_follow_up TO transfer_app;
