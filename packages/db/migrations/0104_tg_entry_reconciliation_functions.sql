-- The reconciliation of a missed TG entry, its review, the PL's reply and the resolution
-- (process-and-lifecycle.md, the reconciliation; Q68 case 2, Q80, Q216 accepted; data-protection.md,
-- the reconciliation's review). Written only by the functions below (ADR-0002); `transfer_app`
-- selects the tables. Lock order (ADR-0002): the project's lock (shared through
-- `lock_participation`; exclusive for the manager's review), the participation row, the packet's
-- document row, then the reconciliation row.
GRANT SELECT ON public.tg_entry_reconciliation, public.tg_entry_reconciliation_step TO transfer_app;
--> statement-breakpoint

-- The audit types this run added are compared as text (they can't be used yet).
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
    'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified', 'tg_entry_reconciled', 'reconciliation_reviewed',
    'reconciliation_replied'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('tg_entry_reconciled', NULL, 'case', false, false, '{evidenceKinds}'),
  ('reconciliation_reviewed', NULL, 'review', false, false, '{}'),
  ('reconciliation_replied', NULL, 'review', false, false, '{}');
--> statement-breakpoint

-- As 0102 wrote it plus the reconciliation's three events (written only by their functions).
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
      'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified', 'tg_entry_reconciled',
      'reconciliation_reviewed', 'reconciliation_replied') THEN
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

-- As 0102 wrote it plus the reconciliation's row: a `reconciliation` entry is refused
-- (`reconciliation_missing`) unless `reconcile_tg_entry` wrote its review row for the same
-- effective date in the same transaction.
CREATE OR REPLACE FUNCTION apply_status_change(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL,
  p_activation boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
  v_signed_on date;
  v_offer uuid;
  v_tg_start date;
  v_cancellation record;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system,participant}');
  IF p_field IS NULL OR p_to IS NULL OR p_activation IS NULL
     OR p_activation AND p_entry_kind IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (process-and-lifecycle.md, project activation): no transition of a draft project, manual or system. The shared
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
      AND (CASE WHEN p_activation THEN e.kind = 'activation'
                WHEN p_entry_kind IS NULL THEN e.kind IN ('manual', 'system')
                ELSE e.kind::text = p_entry_kind::text END)
  ) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  -- Track activity (process-and-lifecycle.md, lifecycle tracks): the tracks move while `informed` (DSV only in ta_tg); in the TG
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

  -- process-and-lifecycle.md: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (process-and-lifecycle.md, TG entry), only they.
  IF (p_scheduled_at IS NULL) = coalesce(p_entry_kind IN ('scheduled_entry', 'scheduled_entry_catchup'), false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  -- The signed TL 407 (process-and-lifecycle.md, profiling track; Q191), held until the commit;
  -- the status service checked the guard on the facts read under the same participation lock.
  IF v_track = 'profiling' AND p_to = 'profiling_done' THEN
    SELECT greatest(d.signed_on, d.countersigned_on) INTO v_signed_on
    FROM public.document d
    WHERE d.id IN (SELECT e.document_id FROM public.tl407_evidence(p_id) e)
    ORDER BY 1, d.id LIMIT 1 FOR SHARE;
    IF p_effective_date < v_signed_on THEN
      RAISE EXCEPTION 'effective_date_before_signature';
    END IF;
  END IF;

  IF v_track = 'dsv' AND p_to = 'dsv_offered' AND NOT EXISTS (
    SELECT FROM public.dsv_offer WHERE participation_id = p_id AND ended_as IS NULL
      AND status_event_id IS NULL AND offer_deadline = p_offer_deadline) THEN
    RAISE EXCEPTION 'dsv_offer_missing';
  END IF;
  IF p_field = 'dsv_status' AND p_to = 'dsv_signed' AND NOT EXISTS (
    SELECT FROM public.dsv_facts(ARRAY[p_id]) f JOIN public.dsv_offer o ON o.id = f.offer_id WHERE o.ended_as IS NULL
  ) THEN RAISE EXCEPTION 'dsv_scan_missing'; END IF;
  -- The TG entry rests on the complete packet (process-and-lifecycle.md, TG entry guard): one counting
  -- scan of the signed offer with the three signatures, valid by the entry date and, for an automatic
  -- entry, recorded before the run's snapshot. Documentary and contractual: no override.
  IF p_field = 'status' AND p_to = 'active_in_tg' AND NOT (
    r.dsv_status = 'dsv_signed' AND p_effective_date IS NOT NULL AND EXISTS (
      SELECT FROM public.dsv_facts(ARRAY[p_id]) f JOIN public.dsv_offer o ON o.id = f.offer_id
      WHERE o.ended_as = 'signed' AND f.executed_on <= p_effective_date
        AND (p_scheduled_at IS NULL OR f.recorded_at <= p_scheduled_at))
  ) THEN RAISE EXCEPTION 'dsv_packet_missing'; END IF;
  -- A reconciliation (process-and-lifecycle.md, the reconciliation; Q68 case 2, Q80) comes with its
  -- review row, written just before by `reconcile_tg_entry` in the same transaction for the same
  -- effective date: never a reconciled entry without its review, whoever calls the status function.
  IF p_entry_kind IS NOT DISTINCT FROM 'reconciliation' AND NOT EXISTS (
    SELECT FROM public.tg_entry_reconciliation t WHERE t.participation_id = p_id
      AND t.status_event_id IS NULL AND t.effective_date = p_effective_date) THEN
    RAISE EXCEPTION 'reconciliation_missing';
  END IF;
  -- A signed DSV is withdrawn only on its cancellation (process-and-lifecycle.md, the cancellation;
  -- Q46 verify, Q213): by a user (the system never withdraws a signed DSV), on or before the
  -- effective TG start (after it, the entry clarification), dated not before the counting
  -- cancellation's validity, which is held until the commit. Contractual: no override (Q71). The
  -- PL's confirmation is the status service's (the guard `withdrawal_after_dsv_signed`).
  IF p_field = 'status' AND p_to = 'withdrawn' AND r.dsv_status = 'dsv_signed' THEN
    IF (p_context).actor_type <> 'user' THEN RAISE EXCEPTION 'withdrawal_after_dsv_signed'; END IF;
    SELECT coalesce(r.tg_start, w.default_tg_start) INTO v_tg_start
    FROM (SELECT 1) x LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id;
    IF v_tg_start IS NULL THEN RAISE EXCEPTION 'tg_start_missing'; END IF;
    IF public.berlin_today() > v_tg_start THEN RAISE EXCEPTION 'after_planned_start'; END IF;
    SELECT f.document_id, f.valid_on INTO v_cancellation
    FROM public.dsv_cancellation_facts(ARRAY[p_id]) f
    ORDER BY f.recorded_at, f.document_id LIMIT 1;
    IF v_cancellation.document_id IS NULL OR v_cancellation.valid_on > public.berlin_today() THEN
      RAISE EXCEPTION 'dsv_cancellation_missing';
    END IF;
    PERFORM FROM public.document WHERE id = v_cancellation.document_id FOR SHARE;
    IF p_effective_date < v_cancellation.valid_on THEN
      RAISE EXCEPTION 'effective_date_before_cancellation';
    END IF;
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
      'offerDeadline', p_offer_deadline,
      'offerOrigin', CASE WHEN p_to = 'dsv_offered' THEN (SELECT origin FROM public.dsv_offer
        WHERE participation_id = p_id AND ended_as IS NULL) END)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies, as system with the same correlation ids
  -- (process-and-lifecycle.md, profiling exceptions).
  IF v_request.status IS NOT DISTINCT FROM 'requested' THEN
    v_stale := CASE
      WHEN r.status IN ('withdrawn', 'ta_completed', 'exited') THEN 'participation_closed'
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
  IF v_track = 'dsv' AND p_expected_from = 'dsv_offered'
     AND p_to IN ('dsv_signed', 'dsv_declined', 'dsv_expired') THEN
    UPDATE public.dsv_offer SET ended_as = CASE p_to WHEN 'dsv_signed' THEN 'signed'
      WHEN 'dsv_declined' THEN 'declined' ELSE 'expired' END, ended_at = now()
    WHERE participation_id = p_id AND ended_as IS NULL
    RETURNING id INTO v_offer;
    IF p_to = 'dsv_signed' THEN
      PERFORM public.sync_dsv_contract(v_offer);
    END IF;
  END IF;
  IF p_field = 'status' AND p_to = 'active_in_tg' THEN
    PERFORM public.sync_dsv_contract(o.id) FROM public.dsv_offer o
    WHERE o.participation_id = p_id AND o.ended_as = 'signed';
  END IF;
  RETURN v_event;
END $$;

--> statement-breakpoint

-- The reconciliation of a missed TG entry (process-and-lifecycle.md, TG entry guard, "Entry after
-- the planned date" case 2; Q68): the PL, for an `informed` participation of a `ta_tg` project,
-- with the evidence the dialog listed (one complete packet, one ASU registration, the TL 407 or the
-- approved exception, each valid on the TG start) and the status version read; the PL's
-- confirmation is required. The effective date is the effective TG start (never another day). The
-- database checks the complete packet as 7-3 built it (a counting scan of the signed offer with the
-- three signatures, valid on the TG start: else `source_changed`, since the dialog showed it) and
-- holds it until the commit; the status service checked the other facts, the day (after the TG
-- start, or on it once that day's run completed) and the permission under the same participation
-- lock with the injected clock. One row and the status change (entry kind `reconciliation`,
-- flagged for review) in one transaction; the status function refuses a reconciliation without
-- its row. Audited as `tg_entry_reconciled` with the kinds only.
CREATE FUNCTION public.reconcile_tg_entry(p_context audit_context, p_participation_id uuid,
  p_status_version integer, p_evidence jsonb, p_confirmed boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_tg_start date;
  v_type public.project_type;
  v_packet jsonb;
  v_item jsonb;
  v_kinds text[];
  v_id uuid;
  v_event uuid;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'array'
     OR pg_catalog.jsonb_array_length(p_evidence) <> 3 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_evidence) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR NOT (v_item ?& '{kind,id,validOn,recordedAt}')
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_item)) <> 4
       OR v_item ->> 'kind' NOT IN ('dsv_packet', 'asu_registration', 'tl407', 'profiling_exception')
       OR v_item ->> 'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT public.iso_date_valid(v_item -> 'validOn')
       OR v_item ->> 'recordedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END LOOP;
  v_kinds := ARRAY(SELECT e ->> 'kind' FROM pg_catalog.jsonb_array_elements(p_evidence) e);
  IF NOT v_kinds @> '{dsv_packet,asu_registration}'
     OR NOT (v_kinds && '{tl407,profiling_exception}')
     OR (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.unnest(v_kinds) k) <> 3
     OR v_kinds @> '{tl407,profiling_exception}' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_confirmed IS NOT TRUE THEN RAISE EXCEPTION 'confirmation_required'; END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  SELECT pj.type, coalesce(r.tg_start, w.default_tg_start) INTO v_type, v_tg_start
  FROM public.project pj LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
  WHERE pj.id = r.project_id;
  IF v_type::text <> 'ta_tg' OR r.status::text <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF v_tg_start IS NULL THEN RAISE EXCEPTION 'tg_start_missing'; END IF;
  -- Never backdated on evidence valid later (Q68): every fact valid on the TG start.
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_evidence) e
             WHERE (e ->> 'validOn')::date > v_tg_start) THEN
    RAISE EXCEPTION 'evidence_after_tg_start';
  END IF;
  SELECT e INTO v_packet FROM pg_catalog.jsonb_array_elements(p_evidence) e
  WHERE e ->> 'kind' = 'dsv_packet';
  IF NOT EXISTS (
    SELECT FROM public.dsv_facts(ARRAY[r.id]) f JOIN public.dsv_offer o ON o.id = f.offer_id
    WHERE o.ended_as = 'signed' AND f.document_id = (v_packet ->> 'id')::uuid
      AND f.executed_on = (v_packet ->> 'validOn')::date) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  PERFORM FROM public.document WHERE id = (v_packet ->> 'id')::uuid FOR SHARE;
  INSERT INTO public.tg_entry_reconciliation (project_id, participation_id, effective_date,
    evidence, confirmed, reconciled_by)
  VALUES (r.project_id, r.id, v_tg_start, p_evidence, true, (p_context).staff_user_id)
  RETURNING id INTO v_id;
  v_event := public.apply_status_change(r.id, 'status', 'informed', 'active_in_tg', p_context,
    p_entry_kind => 'reconciliation', p_effective_date => v_tg_start);
  UPDATE public.tg_entry_reconciliation SET status_event_id = v_event WHERE id = v_id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'tg_entry_reconciled', p_context, NULL,
    NULL, NULL, NULL, v_tg_start,
    pg_catalog.jsonb_build_object('reconciliationId', v_id, 'evidenceKinds',
      pg_catalog.to_jsonb(v_kinds)), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The regional operations manager's review (Q80; Q216): a manager of the project's region, never
-- the PL who reconciled (`four_eyes`, also for one person holding both roles), under the exclusive
-- project lock, against the revision read (`stale_reconciliation`). `requested` takes
-- `no_objection` or `clarification_requested`; after the PL's reply `resolved_no_objection`,
-- `escalated_to_dpo` or another request; an escalation only `resolved_no_objection` (on the DPO's
-- documented instruction). A request needs its reason code, every outcome but `no_objection` a
-- documented source (Q209's rules). Never a status change, never a deadline. Audited in the review
-- stream by the outcome and the reason code, never the source.
CREATE FUNCTION public.review_reconciliation(p_context audit_context, p_reconciliation_id uuid,
  p_outcome text, p_code text, p_source text, p_expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t public.tg_entry_reconciliation;
  r public.participation;
  v_source text := CASE WHEN p_source IS NOT NULL THEN public.normalise_correction_source(p_source) END;
  v_open text[];
BEGIN
  IF p_reconciliation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_outcome IS NULL OR p_outcome NOT IN ('no_objection', 'clarification_requested',
       'resolved_no_objection', 'escalated_to_dpo')
     OR (p_outcome = 'clarification_requested') <> (p_code IS NOT NULL)
     OR p_code IS NOT NULL AND p_code NOT IN ('evidence_unclear', 'date_unclear', 'other_documented')
     OR (p_outcome = 'no_objection') <> (p_source IS NULL)
     OR p_source IS NOT NULL AND (v_source IS NULL OR pg_catalog.char_length(v_source) > 200) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project and participation never change, so they can be read before the locks.
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_not_found'; END IF;
  PERFORM public.assert_context(p_context, t.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(t.project_id));
  SELECT * INTO r FROM public.participation WHERE id = t.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id FOR UPDATE;
  IF t.reconciled_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'four_eyes'; END IF;
  IF t.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_reconciliation'; END IF;
  v_open := CASE t.stage WHEN 'requested' THEN '{no_objection,clarification_requested}'::text[]
    WHEN 'replied' THEN '{resolved_no_objection,escalated_to_dpo,clarification_requested}'::text[]
    WHEN 'escalated_to_dpo' THEN '{resolved_no_objection}'::text[] ELSE '{}'::text[] END;
  IF pg_catalog.cardinality(v_open) = 0 THEN RAISE EXCEPTION 'not_awaiting'; END IF;
  IF NOT p_outcome = ANY (v_open) THEN RAISE EXCEPTION 'outcome_not_allowed'; END IF;
  UPDATE public.tg_entry_reconciliation SET stage = p_outcome, revision = t.revision + 1
  WHERE id = t.id RETURNING * INTO t;
  INSERT INTO public.tg_entry_reconciliation_step (project_id, participation_id,
    reconciliation_id, seq, kind, code, source, by)
  VALUES (t.project_id, t.participation_id, t.id, t.revision, p_outcome, p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'reconciliation_reviewed',
    p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('reconciliationId', t.id,
      'outcome', p_outcome, 'reasonCode', p_code)), false);
  RETURN t.id;
END $$;
--> statement-breakpoint

-- The PL's reply to the manager's request (Q216): a PL of the project, while the request awaits it
-- (`not_awaiting`), against the revision read (`stale_reconciliation`), with a reply code and a
-- documented source. Supplementing evidence happens through its own operations; the reply changes
-- no status. Audited in the review stream by the code, never the source.
CREATE FUNCTION public.reply_reconciliation_clarification(p_context audit_context,
  p_reconciliation_id uuid, p_code text, p_source text, p_expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t public.tg_entry_reconciliation;
  v_source text := public.normalise_correction_source(p_source);
BEGIN
  IF p_reconciliation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_code IS NULL OR p_code NOT IN ('evidence_supplemented', 'explained',
       'correction_requested')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_not_found'; END IF;
  PERFORM public.assert_context(p_context, t.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  PERFORM public.lock_participation(t.participation_id);
  IF NOT public.document_staff_roles(t.participation_id, (p_context).staff_user_id)
     && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id FOR UPDATE;
  IF t.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_reconciliation'; END IF;
  IF t.stage <> 'clarification_requested' THEN RAISE EXCEPTION 'not_awaiting'; END IF;
  UPDATE public.tg_entry_reconciliation SET stage = 'replied', revision = t.revision + 1
  WHERE id = t.id RETURNING * INTO t;
  INSERT INTO public.tg_entry_reconciliation_step (project_id, participation_id,
    reconciliation_id, seq, kind, code, source, by)
  VALUES (t.project_id, t.participation_id, t.id, t.revision, 'replied', p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'reconciliation_replied',
    p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('reconciliationId', t.id, 'replyCode', p_code), false);
  RETURN t.id;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION reconcile_tg_entry, review_reconciliation,
  reply_reconciliation_clarification FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reconcile_tg_entry, review_reconciliation,
  reply_reconciliation_clarification TO transfer_app;
