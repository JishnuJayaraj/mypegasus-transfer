-- Hand-written (ADR-0002, BA reporting tasks; process-and-lifecycle.md, BA reporting; D28, Q111,
-- Q190, Q207): the PL or back office closes a pending BA reporting task once, `reported` with the
-- actual date it was sent or `not_required` with a closed reason. The task is never deleted or
-- edited; a wrong outcome is superseded by an approved correction later (data-protection.md,
-- evidence corrections). No due date, and nothing here pretends to enforce a monthly claim or a
-- project closure. The history's projection row and the grants. Same hardening as 0082: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. The event type 0083 added is compared as text here, since this runs after
-- it in the same migration run.
--
-- Lock order (ADR-0002, D31): the project's shared advisory lock and the participation row
-- (`lock_participation`), then the task `FOR UPDATE`. No setting is read: nothing to resolve.

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
    'ba_report_recorded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): in the `dsv` stream beside the
-- contractual date change that created the task, by its kind, outcome, date or reason.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('ba_report_recorded', NULL, 'dsv', false, false, '{kind,outcome,reportedOn,reason}');
--> statement-breakpoint

-- The function transfer_app may execute.

-- "Gemeldet am" / "Nicht erforderlich" (process-and-lifecycle.md, BA reporting; D28): a staff
-- user acting as themselves (`actor_not_allowed` on behalf of a participant), the PL or back
-- office of the participation's project (`actor_not_allowed` otherwise, a consultant too; the API
-- answers 404 first where the viewer can't read the task) closes a pending task
-- (`already_recorded` once closed; `task_not_found` for an id that isn't one). `reported` takes
-- the sent date, not after today in Berlin (`date_in_future`) and not before the task's Berlin day
-- (`date_before_task`); `not_required` takes the reason; any other shape is `invalid_argument`. A
-- closed participation's task is closed too: an early exit's is created at the exit. Audited
-- `ba_report_recorded`.
CREATE FUNCTION record_ba_report(
  p_context audit_context, p_task_id uuid, p_outcome ba_reporting_status, p_reported_on date,
  p_reason ba_report_not_required_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_participation_id uuid;
  v_shape_ok boolean := CASE p_outcome::text
    WHEN 'reported' THEN p_reported_on IS NOT NULL AND p_reason IS NULL
    WHEN 'not_required' THEN p_reason IS NOT NULL AND p_reported_on IS NULL
    ELSE false END;
  t public.ba_reporting_task;
BEGIN
  IF p_task_id IS NULL OR NOT coalesce(v_shape_ok, false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- participation_id never changes, so it can be read before the lock.
  SELECT participation_id INTO v_participation_id FROM public.ba_reporting_task
  WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.lock_participation(v_participation_id);
  IF NOT public.document_staff_roles(v_participation_id, (p_context).staff_user_id)
      && ARRAY['project_lead', 'back_office'] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.ba_reporting_task WHERE id = p_task_id FOR UPDATE;
  IF t.status::text <> 'pending' THEN
    RAISE EXCEPTION 'already_recorded';
  END IF;
  IF p_reported_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_reported_on < (t.created_at AT TIME ZONE 'Europe/Berlin')::date THEN
    RAISE EXCEPTION 'date_before_task';
  END IF;
  UPDATE public.ba_reporting_task SET status = p_outcome, reported_on = p_reported_on,
    not_required_reason = p_reason, decided_by = (p_context).staff_user_id, decided_at = now()
  WHERE id = t.id;
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'ba_report_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL,
    CASE p_outcome::text
      WHEN 'reported' THEN pg_catalog.jsonb_build_object('taskId', t.id,
        'kind', t.reporting_kind, 'outcome', p_outcome,
        'reportedOn', pg_catalog.to_char(p_reported_on, 'YYYY-MM-DD'))
      ELSE pg_catalog.jsonb_build_object('taskId', t.id, 'kind', t.reporting_kind,
        'outcome', p_outcome, 'reason', p_reason)
    END, false);
END $$;
--> statement-breakpoint

-- `record_audit_event` (0082) refuses the new type: only its function writes it.
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
      'agentur_submission_original_retained', 'ba_report_recorded') THEN
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

-- Grants: transfer_app already selects `ba_reporting_task` (0032); it executes the write.
REVOKE ALL ON FUNCTION record_ba_report FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_ba_report TO transfer_app;
