-- The entry clarification and the bulk DSV generation (process-and-lifecycle.md, the entry
-- clarification; the DSV: generation). `entry_clarification` is written only by the functions below
-- (ADR-0002); `transfer_app` selects it. Lock order: the project's lock, the participation row,
-- then the clarification row (a decision takes the exclusive project lock).
GRANT SELECT ON public.entry_clarification TO transfer_app;
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
    'entry_clarification_instructed'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('entry_clarification_recorded', NULL, 'case', false, false, '{pendingCode}'),
  ('entry_clarification_escalated', NULL, 'case', false, false, '{pendingCode}'),
  ('entry_clarification_instructed', NULL, 'case', false, false, '{instructionCode}');
--> statement-breakpoint

-- Written only by the entry clarification's functions as well (ADR-0002); as 0096 wrote it plus the
-- three entry clarification events.
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
      'entry_clarification_instructed') THEN
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

-- The DSV generation as 0090 wrote it, with `p_batch_size` (1 to 100) for a bulk generation: the
-- project's exclusive lock before any participation row, the batch size in the audit event. The
-- API generates a batch in one transaction, in participation id order: all or nothing.
DROP FUNCTION "public"."record_form_generation"("public"."audit_context", uuid, uuid, uuid, "public"."form_code", text, jsonb, jsonb, text, text, jsonb, text[], boolean, integer, text, text, bytea, jsonb, text, date, "public"."dsv_deadline_kind");
--> statement-breakpoint
CREATE FUNCTION record_form_generation(
  p_context audit_context, p_participation_id uuid, p_generation_id uuid, p_document_id uuid,
  p_form_code form_code, p_form_version text, p_sources jsonb, p_person jsonb,
  p_source_token text, p_organisation_sha256 text, p_declarations jsonb,
  p_confirmed_warnings text[], p_anlage boolean, p_size_bytes integer, p_content_sha256 text,
  p_key_id text, p_wrapped_key bytea, p_checklist jsonb DEFAULT NULL,
  p_employer_sha256 text DEFAULT NULL, p_offer_deadline date DEFAULT NULL,
  p_deadline_kind dsv_deadline_kind DEFAULT NULL, p_batch_size integer DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_dsv boolean := p_form_code::text = 'dsv';
  v_kug boolean := p_form_code::text = 'kug200b';
  pol public.document_type_policy;
  r public.participation;
  pj public.project;
  w public.project_entry_wave;
  pr public.participant_profiling;
  v_profile integer;
  v_assessment integer;
  v_unemployment integer;
  v_code text;
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date;
  v_tg_start date;
  v_project_id uuid;
  v_type text;
  -- An IF condition ends at its first THEN, so the pattern is chosen here.
  v_version_pattern text := CASE WHEN p_form_code::text = 'dsv' THEN '^v[1-9][0-9]{0,3}$'
    ELSE '^(0[1-9]|1[0-2])-[0-9]{4}$' END;
BEGIN
  IF p_generation_id IS NULL OR p_document_id IS NULL OR p_form_code IS NULL
     OR p_form_version IS NULL
     OR p_form_version !~ v_version_pattern
     OR NOT public.form_sources_valid(p_sources)
     OR NOT public.form_person_valid(p_person)
     OR p_source_token IS NULL OR p_source_token !~ '^[0-9a-f]{64}$'
     OR p_organisation_sha256 IS NULL OR p_organisation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_confirmed_warnings IS NULL
     OR NOT p_confirmed_warnings <@ '{age_implausible,entry_before_birth,range_reversed,school_qualification_none}'::text[]
     OR (SELECT pg_catalog.count(DISTINCT c) FROM pg_catalog.unnest(p_confirmed_warnings) c)
       <> pg_catalog.cardinality(p_confirmed_warnings)
     OR p_anlage IS NULL OR p_size_bytes IS NULL OR p_size_bytes NOT BETWEEN 1 AND 10485760
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR p_wrapped_key IS NULL OR pg_catalog.octet_length(p_wrapped_key) <> 60 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_form_code::text NOT IN ('tl407', 'kug200b', 'dsv') THEN
    RAISE EXCEPTION 'form_not_supported';
  END IF;
  IF (v_dsv OR v_kug) AND (p_declarations IS NOT NULL
       OR pg_catalog.cardinality(p_confirmed_warnings) > 0 OR p_anlage
       OR NOT public.form_checklist_valid(p_checklist))
     OR v_kug AND (p_employer_sha256 IS NULL OR p_employer_sha256 !~ '^[0-9a-f]{64}$')
     OR v_dsv AND (p_employer_sha256 IS NOT NULL OR p_offer_deadline IS NULL
       OR p_deadline_kind IS NULL)
     OR NOT v_dsv AND (p_offer_deadline IS NOT NULL OR p_deadline_kind IS NOT NULL)
     OR p_batch_size IS NOT NULL AND (NOT v_dsv OR p_batch_size NOT BETWEEN 1 AND 100)
     OR NOT v_dsv AND NOT v_kug AND (p_checklist IS NOT NULL OR p_employer_sha256 IS NOT NULL
       OR NOT public.form_declarations_valid(p_declarations)) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_type := CASE p_form_code::text WHEN 'dsv' THEN 'dsv_form' WHEN 'kug200b' THEN 'kug200b_form'
    ELSE 'tl407_form' END;
  pol := public.current_document_policy(v_type::public.document_type);
  IF v_dsv THEN
    PERFORM public.assert_context(p_context, p_participation_id, '{user}');
    IF (p_context).on_behalf_of IS NOT NULL THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    -- A bulk generation (1 to 100 DSV, one transaction, all or nothing) takes the project's
    -- exclusive lock before any participation row (lock order, ADR-0002); the calls of one batch
    -- run in participation id order. The shared lock `lock_participation` takes follows.
    IF p_batch_size IS NOT NULL THEN
      SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
      IF v_project_id IS NULL THEN RAISE EXCEPTION 'participation_not_found'; END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project_id));
    END IF;
    r := public.lock_participation(p_participation_id);
    IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id)
       && '{project_lead,back_office}'::text[] THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    SELECT * INTO pj FROM public.project WHERE id = r.project_id;
    SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
    v_tg_start := coalesce(r.tg_start, w.default_tg_start);
    IF r.dsv_status::text = 'dsv_offered' THEN
      RAISE EXCEPTION 'dsv_offer_open';
    END IF;
    IF pj.type <> 'ta_tg' OR pj.status <> 'active'
       OR r.status IN ('withdrawn', 'ta_completed', 'exited') OR w.id IS NULL
       OR v_tg_start IS NULL OR coalesce(r.tg_end, w.default_tg_end) IS NULL
       OR r.dsv_status::text NOT IN ('not_offered', 'dsv_declined', 'dsv_expired')
       OR pj.dsv_template_version IS NULL THEN
      RAISE EXCEPTION 'dsv_not_generatable';
    END IF;
    IF pj.dsv_template_version <> p_form_version THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    IF p_deadline_kind::text = 'wave' AND r.dsv_status::text <> 'not_offered' THEN
      RAISE EXCEPTION 'offer_deadline_invalid';
    END IF;
    IF p_deadline_kind::text = 'wave'
       AND w.signing_deadline IS DISTINCT FROM p_offer_deadline THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    IF w.latest_entry_date IS NULL OR p_offer_deadline < v_today
       OR p_offer_deadline > w.latest_entry_date OR p_offer_deadline > v_tg_start THEN
      RAISE EXCEPTION 'offer_deadline_invalid';
    END IF;
  ELSIF v_kug THEN
    r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  ELSE
    r := public.lock_profiler(p_participation_id, p_context);
  END IF;
  SELECT revision INTO v_profile FROM public.participant_profile WHERE participation_id = r.id;
  SELECT * INTO pr FROM public.participant_profiling WHERE participation_id = r.id;
  SELECT revision INTO v_assessment FROM public.participant_profiling_assessment
  WHERE participation_id = r.id;
  SELECT unemployment_revision INTO v_unemployment FROM public.participant_residence_social_data
  WHERE participation_id = r.id;
  IF coalesce(v_profile, 0) <> (p_sources ->> 'profile')::integer
     OR public.form_person(r.id) IS DISTINCT FROM p_person
     OR v_dsv AND public.dsv_source_token(r.id, p_organisation_sha256)
       IS DISTINCT FROM p_source_token
     OR v_kug AND (SELECT pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(p.customer_name, 'UTF8')), 'hex')
       FROM public.project p WHERE p.id = r.project_id) IS DISTINCT FROM p_employer_sha256
     OR NOT v_kug AND NOT v_dsv AND (coalesce(pr.revision, 0) <> (p_sources ->> 'profiling')::integer
       OR coalesce(v_assessment, 0) <> (p_sources ->> 'assessment')::integer
       OR coalesce(v_unemployment, 0) <> (p_sources ->> 'unemployment')::integer
       OR pr.jobboerse_choice::text IS DISTINCT FROM p_declarations ->> 'jobboerseChoice'
       OR pr.ba_contact_consent IS DISTINCT FROM
         (p_declarations ->> 'baContactConsent')::boolean) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf)
  VALUES (p_document_id, r.project_id, r.id, pol.type, pol.catalog_version,
    pol.retention_class, 'application/pdf', p_size_bytes, p_content_sha256, NULL, p_key_id,
    p_wrapped_key, 'user', (p_context).staff_user_id, false);
  INSERT INTO public.form_generation (id, project_id, participation_id, document_id, form_code,
    form_version, profile_revision, profiling_revision, assessment_revision,
    unemployment_revision, source_token, organisation_sha256, jobboerse_choice,
    ba_contact_consent, confirmed_warnings, anlage, checklist, offer_deadline, deadline_kind,
    generated_by)
  VALUES (p_generation_id, r.project_id, r.id, p_document_id, p_form_code, p_form_version,
    (p_sources ->> 'profile')::integer, (p_sources ->> 'profiling')::integer,
    (p_sources ->> 'assessment')::integer, (p_sources ->> 'unemployment')::integer,
    p_source_token, p_organisation_sha256,
    CASE WHEN NOT v_kug AND NOT v_dsv THEN pr.jobboerse_choice END,
    CASE WHEN NOT v_kug AND NOT v_dsv THEN pr.ba_contact_consent END,
    p_confirmed_warnings, p_anlage, p_checklist, p_offer_deadline, p_deadline_kind,
    (p_context).staff_user_id);
  IF v_dsv THEN
    PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_form_generated', p_context, NULL,
      NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_document_id,
        'templateVersion', p_form_version, 'deadlineKind', p_deadline_kind) ||
        CASE WHEN p_batch_size IS NULL THEN '{}'::jsonb
          ELSE pg_catalog.jsonb_build_object('batchSize', p_batch_size) END, false);
    RETURN p_generation_id;
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'form_generated', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_document_id,
      'formCode', p_form_code, 'formVersion', p_form_version, 'anlage', p_anlage), false);
  FOREACH v_code IN ARRAY p_confirmed_warnings LOOP
    PERFORM public.write_audit_event(r.project_id, r.id, 'warning_confirmed', p_context, NULL,
      NULL, NULL, v_code, NULL, '{}'::jsonb, false);
  END LOOP;
  RETURN p_generation_id;
END $$;
--> statement-breakpoint

-- The Berlin day the entry clarification of a participation opened (the day after the effective
-- planned TG start), or NULL while none is open: a `ta_tg` participation with a signed DSV still
-- `informed` whose planned start has passed. Internal (no grant); the callers hold the locks.
CREATE FUNCTION public.entry_clarification_opened_on(p_participation_id uuid) RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT CASE WHEN pj.type::text = 'ta_tg' AND r.status::text = 'informed'
     AND r.dsv_status::text = 'dsv_signed'
     AND coalesce(r.tg_start, w.default_tg_start) IS NOT NULL
     AND public.berlin_today() > coalesce(r.tg_start, w.default_tg_start)
   THEN coalesce(r.tg_start, w.default_tg_start) + 1 END
 FROM public.participation r JOIN public.project pj ON pj.id = r.project_id
 LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
 WHERE r.id = p_participation_id
$$;
--> statement-breakpoint

-- The PL documents what is pending on a signed DSV that has not entered (Q214, D12): one of four
-- codes with a documented source (Q209's rules: NFC, one line, 1 to 200 characters), against the
-- status version read (`stale_status_version`). The clarification must be open
-- (`clarification_not_open`); one row per participation and planned start, so a second record
-- replaces the code and source of the same row, never opens another; once escalated, only the
-- manager's instruction follows (`clarification_escalated`). Audited by the code, never the source.
CREATE FUNCTION public.record_entry_clarification(p_context audit_context,
  p_participation_id uuid, p_code text, p_source text, p_status_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  c public.entry_clarification;
  v_source text := public.normalise_correction_source(p_source);
  v_opened date;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
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
  v_opened := public.entry_clarification_opened_on(r.id);
  IF v_opened IS NULL THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  SELECT * INTO c FROM public.entry_clarification
  WHERE participation_id = r.id AND opened_on = v_opened FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.entry_clarification (project_id, participation_id, opened_on, pending_code,
      pending_source, pending_recorded_at, pending_recorded_by)
    VALUES (r.project_id, r.id, v_opened, p_code, v_source, pg_catalog.now(),
      (p_context).staff_user_id)
    RETURNING * INTO c;
  ELSIF c.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'clarification_escalated';
  ELSE
    UPDATE public.entry_clarification SET pending_code = p_code, pending_source = v_source,
      pending_recorded_at = pg_catalog.now(), pending_recorded_by = (p_context).staff_user_id
    WHERE id = c.id;
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', p_code), false);
  RETURN c.id;
END $$;
--> statement-breakpoint

-- The PL escalates a documented clarification to the regional operations manager, once
-- (`clarification_not_documented` without a pending code, `already_escalated`). The case stays open:
-- neither the PL nor the manager can enter or end the participation by it.
CREATE FUNCTION public.escalate_entry_clarification(p_context audit_context,
  p_participation_id uuid, p_status_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  c public.entry_clarification;
  v_opened date;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  v_opened := public.entry_clarification_opened_on(r.id);
  IF v_opened IS NULL THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  SELECT * INTO c FROM public.entry_clarification
  WHERE participation_id = r.id AND opened_on = v_opened FOR UPDATE;
  IF NOT FOUND OR c.pending_code IS NULL THEN RAISE EXCEPTION 'clarification_not_documented'; END IF;
  IF c.escalated_at IS NOT NULL THEN RAISE EXCEPTION 'already_escalated'; END IF;
  UPDATE public.entry_clarification SET escalated_at = pg_catalog.now(),
    escalated_by = (p_context).staff_user_id WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_escalated', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', c.pending_code), false);
  RETURN c.id;
END $$;
--> statement-breakpoint

-- The regional operations manager of the project's region records the instruction after an
-- escalation, once, never the PL who escalated (`same_person_instruction`; a PL has no such role
-- by it: `actor_not_allowed`). Under the exclusive project lock, like every decision. It does not
-- change the status: the case stays open until the participation leaves `informed`. Audited by the
-- code, never the source.
CREATE FUNCTION public.record_clarification_instruction(p_context audit_context,
  p_clarification_id uuid, p_code text, p_source text, p_status_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.entry_clarification;
  r public.participation;
  v_source text := public.normalise_correction_source(p_source);
BEGIN
  IF p_clarification_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_code IS NULL OR p_code NOT IN ('legal_advice_obtained', 'dpo_instruction',
       'authority_or_court_decision', 'parties_agreement')
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
  IF c.opened_on IS DISTINCT FROM public.entry_clarification_opened_on(r.id) THEN
    RAISE EXCEPTION 'clarification_not_open';
  END IF;
  IF c.escalated_at IS NULL THEN RAISE EXCEPTION 'not_escalated'; END IF;
  IF c.instruction_code IS NOT NULL THEN RAISE EXCEPTION 'already_instructed'; END IF;
  IF c.escalated_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'same_person_instruction'; END IF;
  UPDATE public.entry_clarification SET instruction_code = p_code, instruction_source = v_source,
    instruction_at = pg_catalog.now(), instruction_by = (p_context).staff_user_id
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_instructed', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'instructionCode', p_code), false);
  RETURN c.id;
END $$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION entry_clarification_opened_on, record_entry_clarification,
  escalate_entry_clarification, record_clarification_instruction, record_form_generation
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_entry_clarification, escalate_entry_clarification,
  record_clarification_instruction, record_form_generation TO transfer_app;
