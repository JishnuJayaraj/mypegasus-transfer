-- The entry clarification's rounds (process-and-lifecycle.md, the entry clarification): every write
-- names the revision it read (`stale_clarification`, checked under the lock, the first record
-- included: 0), every step is kept in `entry_clarification_step`, the manager can ask the PL again
-- (`request_entry_clarification_reply`: the case returns to the PL, who replies by recording again
-- and escalates again), and an unresolved case stays open and actionable while the participation is
-- `informed`, whatever its planned start became. None of it changes a status.
GRANT SELECT ON public.entry_clarification_step TO transfer_app;
--> statement-breakpoint

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
    'agentur_submission_rejected', 'agentur_submission_original_retained',
    'ba_report_recorded', 'exception_evidence_recorded',
    'evidence_correction_requested', 'evidence_correction_decided', 'dsv_form_generated', 'dsv_original_recorded',
    'entry_clarification_recorded', 'entry_clarification_escalated',
    'entry_clarification_instructed', 'entry_clarification_requested'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES ('entry_clarification_requested', NULL, 'case', false, false, '{requestCode}');
--> statement-breakpoint

-- As 0098 wrote it plus the request event.
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
      'agentur_submission_original_sent', 'agentur_submission_rejected',
      'agentur_submission_original_retained', 'ba_report_recorded',
      'exception_evidence_recorded', 'evidence_correction_requested',
      'evidence_correction_decided', 'dsv_form_generated', 'dsv_template_pinned', 'dsv_original_recorded',
      'entry_clarification_recorded', 'entry_clarification_escalated',
      'entry_clarification_instructed', 'entry_clarification_requested') THEN
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

DROP FUNCTION public.record_entry_clarification(audit_context, uuid, text, text, integer);
--> statement-breakpoint
DROP FUNCTION public.escalate_entry_clarification(audit_context, uuid, integer);
--> statement-breakpoint
DROP FUNCTION public.record_clarification_instruction(audit_context, uuid, text, text, integer);
--> statement-breakpoint

-- The PL documents what is pending, or replies to the manager's request (Q214, Q209's source
-- rules). The status version and the clarification's revision read must still hold
-- (`stale_status_version`, `stale_clarification`). The case is the participation's unresolved one,
-- whatever its planned start became, or a new one when the planned start passed and none is
-- unresolved. Replaces the note until the case is escalated (`clarification_escalated`).
CREATE FUNCTION public.record_entry_clarification(p_context audit_context,
  p_participation_id uuid, p_code text, p_source text, p_status_version integer,
  p_expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  c public.entry_clarification;
  v_source text := public.normalise_correction_source(p_source);
  v_opened date;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_code IS NULL OR p_code NOT IN ('awaiting_countersignature', 'awaiting_asu_proof',
       'awaiting_profiling', 'awaiting_legal_advice')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  IF r.status::text <> 'informed' THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  SELECT * INTO c FROM public.entry_clarification
  WHERE participation_id = r.id AND stage <> 'instructed' FOR UPDATE;
  IF FOUND THEN
    IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
    IF c.stage = 'escalated' THEN RAISE EXCEPTION 'clarification_escalated'; END IF;
    UPDATE public.entry_clarification SET stage = 'documented', pending_code = p_code,
      pending_source = v_source, pending_recorded_at = pg_catalog.now(),
      pending_recorded_by = (p_context).staff_user_id, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  ELSE
    v_opened := public.entry_clarification_opened_on(r.id);
    IF v_opened IS NULL THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
    IF EXISTS (SELECT FROM public.entry_clarification
               WHERE participation_id = r.id AND opened_on = v_opened) THEN
      RAISE EXCEPTION 'already_instructed';
    END IF;
    IF p_expected_revision <> 0 THEN RAISE EXCEPTION 'stale_clarification'; END IF;
    INSERT INTO public.entry_clarification (project_id, participation_id, opened_on, stage,
      revision, pending_code, pending_source, pending_recorded_at, pending_recorded_by)
    VALUES (r.project_id, r.id, v_opened, 'documented', 1, p_code, v_source, pg_catalog.now(),
      (p_context).staff_user_id)
    RETURNING * INTO c;
  END IF;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, 'recorded', p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', p_code), false);
  RETURN c.id;
END $$;
--> statement-breakpoint

-- The PL escalates the documented note they saw (the revision read) to the regional operations
-- manager: `clarification_not_documented` without a note or while a reply to the manager's request
-- is still to be recorded, `already_escalated`.
CREATE FUNCTION public.escalate_entry_clarification(p_context audit_context,
  p_participation_id uuid, p_status_version integer, p_expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  c public.entry_clarification;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  IF r.status::text <> 'informed' THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  SELECT * INTO c FROM public.entry_clarification
  WHERE participation_id = r.id AND stage <> 'instructed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'clarification_not_documented'; END IF;
  IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
  IF c.stage = 'escalated' THEN RAISE EXCEPTION 'already_escalated'; END IF;
  IF c.stage <> 'documented' THEN RAISE EXCEPTION 'clarification_not_documented'; END IF;
  UPDATE public.entry_clarification SET stage = 'escalated', escalated_at = pg_catalog.now(),
    escalated_by = (p_context).staff_user_id, revision = c.revision + 1
  WHERE id = c.id RETURNING * INTO c;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, 'escalated', c.pending_code, c.pending_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_escalated', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', c.pending_code), false);
  RETURN c.id;
END $$;
--> statement-breakpoint

-- The manager's side: the case they may answer is an escalated one of a project of their region,
-- whatever its planned start became, while the participation is `informed`. Under the exclusive
-- project lock, never the person who escalated (`same_person_instruction`). `p_kind` is
-- 'instructed' or 'requested'.
CREATE FUNCTION public.answer_entry_clarification(p_context audit_context,
  p_clarification_id uuid, p_kind text, p_code text, p_source text, p_status_version integer,
  p_expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.entry_clarification;
  r public.participation;
  v_source text := public.normalise_correction_source(p_source);
BEGIN
  IF p_clarification_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_kind IS NULL OR p_kind NOT IN ('instructed', 'requested') OR p_code IS NULL
     OR p_kind = 'instructed' AND p_code NOT IN ('legal_advice_obtained', 'dpo_instruction',
       'authority_or_court_decision', 'parties_agreement')
     OR p_kind = 'requested' AND p_code NOT IN ('evidence_unclear', 'date_unclear',
       'other_documented')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project and participation never change, so they can be read before the locks.
  SELECT * INTO c FROM public.entry_clarification WHERE id = p_clarification_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'clarification_not_found'; END IF;
  PERFORM public.assert_context(p_context, c.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(c.project_id));
  SELECT * INTO r FROM public.participation WHERE id = c.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO c FROM public.entry_clarification WHERE id = p_clarification_id FOR UPDATE;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  IF r.status::text <> 'informed' THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
  IF c.stage = 'instructed' THEN RAISE EXCEPTION 'already_instructed'; END IF;
  IF c.stage <> 'escalated' THEN RAISE EXCEPTION 'not_escalated'; END IF;
  IF c.escalated_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'same_person_instruction'; END IF;
  IF p_kind = 'instructed' THEN
    UPDATE public.entry_clarification SET stage = 'instructed', instruction_code = p_code,
      instruction_source = v_source, instruction_at = pg_catalog.now(),
      instruction_by = (p_context).staff_user_id, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  ELSE
    -- Back to the PL: the escalation is withdrawn from the row (its step stays in the history).
    UPDATE public.entry_clarification SET stage = 'returned', escalated_at = NULL,
      escalated_by = NULL, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  END IF;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, p_kind, p_code, v_source,
    (p_context).staff_user_id);
  IF p_kind = 'instructed' THEN
    PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_instructed',
      p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('clarificationId', c.id, 'instructionCode', p_code), false);
  ELSE
    PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_requested',
      p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('clarificationId', c.id, 'requestCode', p_code), false);
  END IF;
  RETURN c.id;
END $$;
--> statement-breakpoint

-- The two answers as functions of their own, so each is granted and named for what it does.
CREATE FUNCTION public.record_clarification_instruction(p_context audit_context,
  p_clarification_id uuid, p_code text, p_source text, p_status_version integer,
  p_expected_revision integer) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.answer_entry_clarification(p_context, p_clarification_id, 'instructed', p_code,
    p_source, p_status_version, p_expected_revision)
$$;
--> statement-breakpoint
CREATE FUNCTION public.request_entry_clarification_reply(p_context audit_context,
  p_clarification_id uuid, p_code text, p_source text, p_status_version integer,
  p_expected_revision integer) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.answer_entry_clarification(p_context, p_clarification_id, 'requested', p_code,
    p_source, p_status_version, p_expected_revision)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION answer_entry_clarification, record_entry_clarification,
  escalate_entry_clarification, record_clarification_instruction,
  request_entry_clarification_reply FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_entry_clarification, escalate_entry_clarification,
  record_clarification_instruction, request_entry_clarification_reply TO transfer_app;
