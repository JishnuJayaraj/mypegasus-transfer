-- Hand-written (ADR-0002, TL 407 submission; process-and-lifecycle.md, TL 407 submission; Q54,
-- Q92, Q188, Q189): the PL records a TL 407's submission to the placement Agentur, "Original
-- versandt am" and the Agentur's rejection; every attempt is its own `agentur_submission` row, a
-- rejection reopens the work until a new submission and never touches the signatures, the scan or
-- the profiling track. The reader of the refusals' dates for the regional view (counts only), the
-- history's projection rows and the grants. Same hardening as 0078: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. The event types 0081 added are compared as text here, since this runs after it in the
-- same migration run.
--
-- What the API resolves (regional-variation.md, blockers): the placement Agentur's submission
-- channel, whether it needs the paper original and the form versions it rejects as outdated come
-- from the configuration layers, which only the API reads. It reads them after taking the
-- project's exclusive lock (`lock_project_setup`), which every configuration write and the
-- placement Agentur's change take, and passes them in with the Agentur they belong to; the
-- function compares that Agentur with the participation's under the lock (`settings_changed`).
-- Null settings are the `agentur_submission` blocker (all four settings, Q92).
--
-- Lock order (ADR-0002, D31): the project's advisory lock (exclusive from the API for a
-- submission, shared through `lock_participation` otherwise), the participation row, the scan
-- `FOR SHARE`, then the participation's submissions `FOR UPDATE` in id order.

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
    'appointment_notice_followed_up', 'missed_appointment_resolved', 'profiling_session_changed',
    'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
    'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
    'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set',
    'kug200b_offer_declined', 'declaration_withdrawal_recorded',
    'declaration_withdrawal_ba_notified', 'agentur_submission_recorded',
    'asu_confirmation_recorded', 'agentur_submission_original_sent',
    'agentur_submission_rejected'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): both in the `profiling`
-- stream by their dates and the reason.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('agentur_submission_original_sent', NULL, 'profiling', false, false, '{originalSentOn}'),
  ('agentur_submission_rejected', NULL, 'profiling', false, false, '{rejectedOn,reason}');
--> statement-breakpoint

-- Internal helper (no grant).

-- The submission of a follow-up (the original, the rejection): the staff user's context, the
-- participation's lock (the shared project lock first), its PL acting as themselves
-- (`actor_not_allowed` otherwise; the API answers 404 first where the viewer can't see it), then
-- the submission row `FOR UPDATE` (`submission_not_found` for an id that isn't one).
CREATE FUNCTION lock_agentur_submission(p_context audit_context, p_submission_id uuid)
RETURNS agentur_submission LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation_id uuid;
  s public.agentur_submission;
BEGIN
  -- participation_id never changes, so it can be read before the lock.
  SELECT participation_id INTO v_participation_id FROM public.agentur_submission
  WHERE id = p_submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.lock_participation(v_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(v_participation_id,
      (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO s FROM public.agentur_submission WHERE id = p_submission_id FOR UPDATE;
  RETURN s;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- "An Agentur übermittelt am" (process-and-lifecycle.md, TL 407 submission; D26): the PL of the
-- participation (`actor_not_allowed` otherwise) records the actual sent date of one of its signed
-- TL 407 scans (`document_not_found` for another document), while the participation is open
-- (`participation_closed`), to its placement Agentur (`placement_agentur_missing`; another than
-- the API resolved: `settings_changed`) with its resolved settings (none: the blocker,
-- `submission_settings_missing`): the scan accepted, live, neither quarantined nor invalidated, with
-- its version (`scan_unusable`); no standing submission (`already_submitted`: a new attempt only
-- after a rejection); a version the Agentur rejects as outdated, which the API passes only where
-- its `rejectsOutdatedFormVersions` is true (`form_version_outdated`, Q188); the date not after
-- today in Berlin (`submitted_on_in_future`), not before the later signature
-- (`submitted_before_signature`) or the last rejection (`submitted_before_rejection`). The row
-- keeps the channel and whether the original is needed. Audited `agentur_submission_recorded`.
-- Returns the id.
CREATE FUNCTION submit_tl407(
  p_context audit_context, p_participation_id uuid, p_submission_id uuid, p_document_id uuid,
  p_submitted_on date, p_agentur_key text, p_channel agentur_submission_channel,
  p_original_required boolean, p_outdated_versions text[]
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  v_last_rejection date;
BEGIN
  IF p_participation_id IS NULL OR p_submission_id IS NULL OR p_document_id IS NULL
     OR p_submitted_on IS NULL OR (p_channel IS NULL) <> (p_original_required IS NULL)
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO d FROM public.document
  WHERE id = p_document_id AND participation_id = r.id AND type = 'tl407_signed_scan'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF r.placement_agentur_key IS NULL THEN
    RAISE EXCEPTION 'placement_agentur_missing';
  END IF;
  IF p_agentur_key IS DISTINCT FROM r.placement_agentur_key THEN
    RAISE EXCEPTION 'settings_changed';
  END IF;
  IF p_channel IS NULL THEN
    RAISE EXCEPTION 'submission_settings_missing';
  END IF;
  IF d.deleted_at IS NOT NULL OR d.review_state <> 'accepted' OR d.quarantined_at IS NOT NULL
     OR d.invalidated_by_correction IS NOT NULL OR d.form_version IS NULL THEN
    RAISE EXCEPTION 'scan_unusable';
  END IF;
  PERFORM FROM public.agentur_submission WHERE participation_id = r.id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT FROM public.agentur_submission
             WHERE participation_id = r.id AND form_code = 'tl407' AND rejected_on IS NULL) THEN
    RAISE EXCEPTION 'already_submitted';
  END IF;
  IF d.form_version = ANY (p_outdated_versions) THEN
    RAISE EXCEPTION 'form_version_outdated';
  END IF;
  IF p_submitted_on > public.berlin_today() THEN
    RAISE EXCEPTION 'submitted_on_in_future';
  END IF;
  IF p_submitted_on < greatest(d.signed_on, d.countersigned_on) THEN
    RAISE EXCEPTION 'submitted_before_signature';
  END IF;
  v_last_rejection := (SELECT pg_catalog.max(rejected_on) FROM public.agentur_submission
                       WHERE participation_id = r.id AND form_code = 'tl407');
  IF p_submitted_on < v_last_rejection THEN
    RAISE EXCEPTION 'submitted_before_rejection';
  END IF;
  INSERT INTO public.agentur_submission (id, project_id, participation_id, document_id, form_code,
    form_version, agentur_key, channel, submitted_on, recorded_by, original_required)
  VALUES (p_submission_id, r.project_id, r.id, d.id, 'tl407', d.form_version, p_agentur_key,
    p_channel, p_submitted_on, (p_context).staff_user_id, p_original_required);
  PERFORM public.write_audit_event(r.project_id, r.id, 'agentur_submission_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('submissionId', p_submission_id,
      'documentId', d.id, 'formCode', 'tl407', 'formVersion', d.form_version,
      'channel', p_channel, 'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD')),
    false);
  RETURN p_submission_id;
END $$;
--> statement-breakpoint

-- "Original versandt am" (D26): the PL records once (`original_recorded`) when the paper original
-- of a TL 407 submission went to the Agentur, where it needed one apart from the submission
-- (`original_not_required`: not required when submitted, a `paper_original` submission, or a
-- batch's Kug 200b), from the submission to today in Berlin (`date_before_submission`,
-- `date_in_future`), also after a rejection or the end (a fact of what was sent). Audited
-- `agentur_submission_original_sent`.
CREATE FUNCTION record_original_sent(
  p_context audit_context, p_submission_id uuid, p_original_sent_on date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.agentur_submission;
BEGIN
  IF p_submission_id IS NULL OR p_original_sent_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_agentur_submission(p_context, p_submission_id);
  IF s.form_code::text <> 'tl407' OR NOT s.original_required
     OR s.channel::text = 'paper_original' THEN
    RAISE EXCEPTION 'original_not_required';
  END IF;
  IF s.original_sent_on IS NOT NULL THEN
    RAISE EXCEPTION 'original_recorded';
  END IF;
  IF p_original_sent_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_original_sent_on < s.submitted_on THEN
    RAISE EXCEPTION 'date_before_submission';
  END IF;
  UPDATE public.agentur_submission SET original_sent_on = p_original_sent_on,
    original_recorded_by = (p_context).staff_user_id, original_recorded_at = now()
  WHERE id = s.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id,
    'agentur_submission_original_sent', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('submissionId', s.id,
      'originalSentOn', pg_catalog.to_char(p_original_sent_on, 'YYYY-MM-DD')), false);
END $$;
--> statement-breakpoint

-- "Von der Agentur abgelehnt" (D26; Q189): the PL records once per attempt (`already_rejected`)
-- the Agentur's rejection of a TL 407 submission (a batch's Kug 200b has no rejection yet,
-- `rejection_not_applicable`, Q204) with its date, from the submission to today in Berlin
-- (`date_before_submission`, `date_in_future`), and its reason; also after the end. It reopens
-- the submission work until a new attempt; the scan, its signatures and the profiling track stay
-- as they are. Audited `agentur_submission_rejected`.
CREATE FUNCTION record_agentur_rejection(
  p_context audit_context, p_submission_id uuid, p_rejected_on date,
  p_reason agentur_rejection_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.agentur_submission;
BEGIN
  IF p_submission_id IS NULL OR p_rejected_on IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_agentur_submission(p_context, p_submission_id);
  IF s.form_code::text <> 'tl407' THEN
    RAISE EXCEPTION 'rejection_not_applicable';
  END IF;
  IF s.rejected_on IS NOT NULL THEN
    RAISE EXCEPTION 'already_rejected';
  END IF;
  IF p_rejected_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_rejected_on < s.submitted_on THEN
    RAISE EXCEPTION 'date_before_submission';
  END IF;
  UPDATE public.agentur_submission SET rejected_on = p_rejected_on, rejection_reason = p_reason,
    rejection_recorded_by = (p_context).staff_user_id, rejection_recorded_at = now()
  WHERE id = s.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id,
    'agentur_submission_rejected', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('submissionId', s.id,
      'rejectedOn', pg_catalog.to_char(p_rejected_on, 'YYYY-MM-DD'), 'reason', p_reason), false);
END $$;
--> statement-breakpoint

-- The regional view's refusal dates (data-protection.md, the regional view; Q57): per
-- participation the effective date of its latest change to `profiling_declined`, else its Berlin
-- day. Dates only; the API counts them per project and never shows a participant.
CREATE FUNCTION profiling_declined_dates(p_participation_ids uuid[])
RETURNS TABLE (participation_id uuid, declined_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT ON (a.participation_id) a.participation_id,
    coalesce(a.effective_date, (a.occurred_at AT TIME ZONE 'Europe/Berlin')::date)
  FROM public.audit_event a
  WHERE a.participation_id = ANY (p_participation_ids) AND a.event_type = 'status_changed'
    AND a.field = 'profiling_status' AND a.to_value = 'profiling_declined'
  ORDER BY a.participation_id, a.occurred_at DESC, a.id DESC
$$;
--> statement-breakpoint

-- `record_audit_event` (0078) refuses the two new types: only their functions write them.
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
      'missed_appointment_resolved', 'profiling_session_changed',
      'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
      'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
      'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set',
      'kug200b_offer_declined', 'declaration_withdrawal_recorded',
      'declaration_withdrawal_ba_notified', 'export_created', 'export_downloaded',
      'kug200b_batch_created', 'kug200b_batch_submitted', 'kug200b_batch_discarded',
      'agentur_submission_recorded', 'asu_confirmation_recorded',
      'agentur_submission_original_sent', 'agentur_submission_rejected') THEN
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

-- Grants: transfer_app already selects `agentur_submission` (0078); it executes the three writes
-- and the reader.
REVOKE ALL ON FUNCTION lock_agentur_submission, submit_tl407, record_original_sent,
  record_agentur_rejection, profiling_declined_dates FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION submit_tl407, record_original_sent, record_agentur_rejection,
  profiling_declined_dates TO transfer_app;
