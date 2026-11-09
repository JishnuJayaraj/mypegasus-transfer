-- The cancellation of a signed DSV, the withdrawal it allows and the customer notice
-- (process-and-lifecycle.md, the cancellation and the customer notice; Q46 verify, Q213 accepted
-- provisionally; data-protection.md, DSV scans). Written only by the functions below (ADR-0002).

-- Catalog version 10: the cancellation takes the signed DSV scan's operations (add and review by
-- the PL and back office, deletion before review by the PL, quarantine and its lift as reviewed).
INSERT INTO public.document_type_policy (type, catalog_version, retention_class, file_name, signed,
 generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles)
SELECT type, 10, retention_class, file_name, signed, generated,
 CASE WHEN type = 'dsv_cancellation' THEN '{project_lead,back_office}'::text[] ELSE add_roles END,
 CASE WHEN type = 'dsv_cancellation' THEN '{project_lead,back_office}'::text[] ELSE review_roles END,
 CASE WHEN type = 'dsv_cancellation' THEN '{project_lead}'::text[] ELSE delete_roles END,
 open_roles,
 CASE WHEN type = 'dsv_cancellation' THEN '{project_lead,back_office}'::text[] ELSE quarantine_roles END
FROM public.document_type_policy WHERE catalog_version = 9;
GRANT SELECT ON public.dsv_customer_notice TO transfer_app;
--> statement-breakpoint

-- The audit type this run added is compared as text (it can't be used yet).
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
    'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES ('dsv_customer_notified', NULL, 'dsv', false, false, '{notifiedOn}');
--> statement-breakpoint

-- As 0100 wrote it plus the customer notice's event (written only by `record_customer_notice`).
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
      'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified') THEN
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

-- The counting cancellations (accepted, live, neither quarantined nor invalidated, with their
-- receiver) of a signed offer that show the three parties' signatures: valid on the latest actual
-- date, recorded at the latest of the acceptance, the signatures' recording and a quarantine's lift
-- (the dates stay the signatures'). `dsv_facts` keeps its rows: a sibling, not a new row kind.
CREATE FUNCTION public.dsv_cancellation_facts(p_ids uuid[])
RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, valid_on date,
  recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT d.participation_id, d.id, o.id, greatest(s.signed_on, c.signed_on, t.signed_on),
   greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at)
 FROM public.document d
 JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
   AND o.ended_as = 'signed'
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
 JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
 JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
 WHERE d.participation_id = ANY(p_ids) AND d.type = 'dsv_cancellation'
 AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.dsv_cancellation_facts FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dsv_cancellation_facts TO transfer_app;
--> statement-breakpoint

-- As 0096 wrote it; the cancellation is uploaded against the signed offer while the participation
-- is `informed` on it, and only the DSV scan compares the participant's date with the offer's.
CREATE OR REPLACE FUNCTION public.add_document(p_context audit_context, p_participation_id uuid, p_id uuid, p_type document_type, p_media_type document_media_type, p_size_bytes integer, p_content_sha256 text, p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL::text, p_scan_origin scan_origin DEFAULT NULL::scan_origin, p_generation_document_id uuid DEFAULT NULL::uuid, p_dsv jsonb DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  pol public.document_type_policy := public.current_document_policy(p_type);
  v_form public.form_code := public.scan_form(p_type);
  v_version text;
  v_roles text[];
  v_project_id uuid;
BEGIN
  IF p_id IS NULL OR p_type IS NULL OR p_media_type IS NULL OR p_size_bytes IS NULL
     OR p_size_bytes NOT BETWEEN 1 AND 10485760
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR p_wrapped_key IS NULL OR pg_catalog.octet_length(p_wrapped_key) <> 60
     OR p_file_name IS NOT NULL AND (pg_catalog.char_length(p_file_name) NOT BETWEEN 1 AND 200
       OR p_file_name ~ '[[:cntrl:]]')
     OR (v_form IS NULL) <> (p_scan_origin IS NULL)
     OR coalesce(p_scan_origin = 'generated', false) <> (p_generation_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(p_participation_id, p_context, p_token_hash, true);
  IF pg_catalog.cardinality(pol.add_roles) = 0 THEN
    RAISE EXCEPTION 'document_type_not_supported';
  END IF;
  IF NOT v_roles && pol.add_roles OR pol.signed AND (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (p_type IN ('dsv_signed_scan', 'dsv_cancellation')) <> (p_dsv IS NOT NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF p_dsv IS NOT NULL THEN
    PERFORM FROM public.dsv_offer WHERE id = (p_dsv->>'offerId')::uuid AND participation_id = p_participation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
    -- The open offer takes the participant's paper; the signed offer also the countersigned original
    -- and, while the participation is `informed` on a signed DSV, the cancellation of the signed
    -- contract (process-and-lifecycle.md, the cancellation).
    IF p_type = 'dsv_cancellation' THEN
      IF NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = (p_dsv->>'offerId')::uuid AND ended_as = 'signed') THEN RAISE EXCEPTION 'source_changed'; END IF;
      IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id AND status = 'informed' AND dsv_status = 'dsv_signed') THEN RAISE EXCEPTION 'cancellation_not_open'; END IF;
    ELSIF NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = (p_dsv->>'offerId')::uuid AND (ended_as IS NULL OR ended_as = 'signed')) THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF NOT EXISTS (SELECT FROM public.staff_user WHERE id = (p_dsv->>'receivedBy')::uuid) THEN RAISE EXCEPTION 'receiver_required'; END IF;
    PERFORM public.validate_dsv_scan(p_dsv->'signatures', (p_dsv->>'receivedOn')::date);
    IF p_type = 'dsv_signed_scan' THEN
      PERFORM public.assert_dsv_participant_date((p_dsv->>'offerId')::uuid, p_dsv->'signatures'->>'participant', NULL);
    END IF;
  END IF;
  IF p_file_name IS NOT NULL AND NOT pol.file_name THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_generation_document_id IS NOT NULL THEN
    SELECT g.form_version INTO v_version
    FROM public.form_generation g
    WHERE g.document_id = p_generation_document_id AND g.participation_id = p_participation_id
      AND g.form_code = v_form;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'generation_not_found';
    END IF;
    PERFORM FROM public.document WHERE id = p_generation_document_id FOR SHARE;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document d
      JOIN public.document_type_policy t
        ON t.type = d.type AND t.catalog_version = d.catalog_version AND NOT t.generated
      WHERE d.participation_id = p_participation_id AND d.deleted_at IS NULL) >= 50 THEN
    RAISE EXCEPTION 'document_limit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document d
      JOIN public.document_type_policy t
        ON t.type = d.type AND t.catalog_version = d.catalog_version AND NOT t.generated
      WHERE d.participation_id = p_participation_id
        AND d.added_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'upload_rate_limited';
  END IF;
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf, scan_origin, generation_document_id,
    form_code, form_version, dsv_offer_id, dsv_received_by, dsv_received_on, dsv_signatures)
  VALUES (p_id, v_project_id, p_participation_id, p_type, pol.catalog_version,
    pol.retention_class, p_media_type, p_size_bytes, p_content_sha256, p_file_name, p_key_id,
    p_wrapped_key, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).on_behalf_of IS NOT NULL, p_scan_origin, p_generation_document_id,
    CASE WHEN v_version IS NOT NULL THEN v_form END, v_version, (p_dsv->>'offerId')::uuid, (p_dsv->>'receivedBy')::uuid, (p_dsv->>'receivedOn')::date, p_dsv->'signatures');
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'document_added', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_id,
      'documentType', p_type, 'source', CASE
        WHEN (p_context).actor_type = 'participant' THEN 'portal'
        WHEN (p_context).on_behalf_of IS NOT NULL THEN 'assisted'
        ELSE 'staff' END), false);
  RETURN p_id;
END $function$;
--> statement-breakpoint

-- As 0096 wrote it plus the cancellation's acceptance with its three signatures.
CREATE OR REPLACE FUNCTION review_document(
  p_context audit_context, p_document_id uuid, p_decision document_review_state,
  p_reason document_review_reason, p_signed_on date DEFAULT NULL,
  p_countersigned_on date DEFAULT NULL, p_confirmations text[] DEFAULT NULL,
  p_form_version text DEFAULT NULL, p_declarations jsonb DEFAULT NULL, p_dsv jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  g public.form_generation;
  c public.consent_record;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_generation_id uuid;
  v_roles text[];
  v_id uuid;
  v_accept boolean := p_decision = 'accepted';
  v_paper boolean := p_signed_on IS NOT NULL OR p_countersigned_on IS NOT NULL
    OR p_confirmations IS NOT NULL OR p_form_version IS NOT NULL OR p_declarations IS NOT NULL;
  v_kug boolean;
  v_version text;
  v_choice text;
  v_contact text;
  v_signed_on date;
  v_consent uuid;
  v_in_force boolean;
  v_text text;
BEGIN
  IF p_document_id IS NULL OR p_decision IS NULL OR p_decision = 'unreviewed'
     OR (p_decision = 'rejected') <> (p_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, generation_document_id INTO v_participation_id, v_generation_id
  FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  -- The documents in id order: the generation held, the scan changed.
  FOR v_id IN SELECT id FROM public.document
    WHERE id IN (p_document_id, v_generation_id) ORDER BY id LOOP
    IF v_id = p_document_id THEN
      SELECT * INTO d FROM public.document WHERE id = v_id AND deleted_at IS NULL FOR UPDATE;
    ELSE
      PERFORM FROM public.document WHERE id = v_id FOR SHARE;
    END IF;
  END LOOP;
  IF d.id IS NULL THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.review_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.review_state <> 'unreviewed' THEN
    RAISE EXCEPTION 'document_reviewed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF (d.type IN ('dsv_signed_scan', 'dsv_cancellation') AND v_accept) <> (p_dsv IS NOT NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  -- The cancellation of the signed contract (process-and-lifecycle.md, the cancellation): accepted
  -- only with the three parties' signatures confirmed, while the participation is `informed` on the
  -- signed DSV; a rejection creates no fact and is always possible.
  IF d.type = 'dsv_cancellation' AND v_accept THEN
    IF NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id AND ended_as = 'signed') THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF NOT EXISTS (SELECT FROM public.participation WHERE id = d.participation_id AND status = 'informed' AND dsv_status = 'dsv_signed') THEN RAISE EXCEPTION 'cancellation_not_open'; END IF;
    IF p_dsv ? 'termsConfirmed' THEN RAISE EXCEPTION 'invalid_argument'; END IF;
    PERFORM public.validate_dsv_scan(p_dsv->'signatures', d.dsv_received_on);
    IF NOT (p_dsv->'signatures') ?& ARRAY['participant', 'customer', 'transfergesellschaft'] THEN
      RAISE EXCEPTION 'cancellation_signatures_missing';
    END IF;
    INSERT INTO public.dsv_scan_signature(project_id, participation_id, document_id, kind, signed_on)
    SELECT d.project_id, d.participation_id, d.id, key, value::date FROM jsonb_each_text(p_dsv->'signatures');
  END IF;
  IF d.type = 'dsv_signed_scan' THEN
    -- A rejection creates no fact, so it is allowed after the offer ended; an acceptance needs the
    -- open offer or the signed one (the countersigned original), never a declined or expired one.
    IF v_accept AND NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id
        AND (ended_as IS NULL OR ended_as = 'signed')) THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF v_accept THEN
      PERFORM public.validate_dsv_scan(p_dsv->'signatures', d.dsv_received_on);
      PERFORM public.assert_dsv_participant_date(d.dsv_offer_id, p_dsv->'signatures'->>'participant', d.id);
      IF EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id AND origin = 'external_paper')
         AND (p_dsv->>'termsConfirmed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'terms_mismatch'; END IF;
      INSERT INTO public.dsv_scan_signature(project_id, participation_id, document_id, kind, signed_on)
      SELECT d.project_id, d.participation_id, d.id, key, value::date FROM jsonb_each_text(p_dsv->'signatures');
    END IF;
  END IF;
  v_kug := d.type::text = 'kug200b_signed_scan';
  IF d.scan_origin IS NULL THEN
    IF v_paper THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSE
    IF (SELECT status FROM public.participation WHERE id = d.participation_id)
       IN ('withdrawn', 'ta_completed', 'exited') THEN
      RAISE EXCEPTION 'participation_closed';
    END IF;
    IF v_accept <> v_paper
       OR v_accept AND (p_signed_on IS NULL OR p_confirmations IS NULL
         OR (d.scan_origin = 'external_paper') <> (p_form_version IS NOT NULL)
         OR p_form_version !~ '^(0[1-9]|1[0-2])-[0-9]{4}$')
       OR v_accept AND v_kug AND (p_countersigned_on IS NOT NULL OR p_declarations IS NOT NULL
         OR NOT p_confirmations @> '{declarations_ticked,mandatory_completed,signature_present}'::text[]
         OR NOT p_confirmations <@ '{declarations_ticked,mandatory_completed,signature_present}'::text[])
       OR v_accept AND NOT v_kug AND (p_countersigned_on IS NULL
         OR NOT p_confirmations @> '{signatures_present,all_pages_present}'::text[]
         OR NOT p_confirmations <@ '{signatures_present,all_pages_present}'::text[]
         OR NOT public.scan_declarations_valid(p_declarations)
         OR d.scan_origin = 'external_paper' AND p_declarations ->> 'kind' = 'as_printed') THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END IF;
  IF v_accept AND d.scan_origin IS NOT NULL THEN
    v_signed_on := greatest(p_signed_on, p_countersigned_on);
    IF v_signed_on > public.berlin_today() THEN
      RAISE EXCEPTION 'signature_in_future';
    END IF;
    IF d.scan_origin = 'generated' THEN
      SELECT * INTO g FROM public.form_generation WHERE document_id = d.generation_document_id;
      IF least(p_signed_on, coalesce(p_countersigned_on, p_signed_on))
         < (g.generated_at AT TIME ZONE 'Europe/Berlin')::date THEN
        RAISE EXCEPTION 'signature_before_generation';
      END IF;
    END IF;
    v_version := coalesce(d.form_version, p_form_version);
    UPDATE public.document SET review_state = 'accepted', reviewed_by = (p_context).staff_user_id,
      reviewed_at = now(), form_code = public.scan_form(d.type), form_version = v_version,
      signed_on = p_signed_on, countersigned_on = p_countersigned_on,
      review_confirmations = CASE WHEN v_kug
        THEN '{declarations_ticked,mandatory_completed,signature_present}'::text[]
        ELSE '{signatures_present,all_pages_present}'::text[] END
    WHERE id = d.id;
    IF v_kug THEN
      INSERT INTO public.signed_declaration (id, project_id, participation_id, document_id,
        form_code, form_version, declaration, value, signed_on, recorded_by)
      VALUES
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id, 'kug200b',
          v_version, 'kug200bJobSeeking', 'yes', v_signed_on, (p_context).staff_user_id),
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id, 'kug200b',
          v_version, 'kug200bProfileAccess', 'yes', v_signed_on, (p_context).staff_user_id);
      PERFORM public.write_audit_event(d.project_id, d.participation_id,
        'signed_declaration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('documentId', d.id, 'formCode', 'kug200b',
          'formVersion', v_version,
          'declarations', '["kug200bJobSeeking","kug200bProfileAccess"]'::jsonb), false);
      -- Declaration 17 as written, one record in force (Q185), by the dates on the papers and of
      -- the withdrawals, never by the order of acceptance: the paper is in force only if signed
      -- after every withdrawal received and not before a usable paper in force.
      v_in_force := p_signed_on > coalesce((SELECT pg_catalog.max(w.received_on)
          FROM public.kug200b_withdrawal w WHERE w.participation_id = d.participation_id),
        '-infinity'::date)
        AND NOT EXISTS (SELECT FROM public.consent_record x
          JOIN public.document s ON s.id = x.document_id
          WHERE x.participation_id = d.participation_id AND x.purpose = 'kug200b_profile_access'
            AND x.ended_at IS NULL AND x.given_on > p_signed_on AND s.deleted_at IS NULL
            AND s.quarantined_at IS NULL AND s.invalidated_by_correction IS NULL);
      IF v_in_force THEN
        FOR c IN SELECT * FROM public.consent_record
          WHERE participation_id = d.participation_id AND purpose = 'kug200b_profile_access'
            AND ended_at IS NULL ORDER BY id FOR UPDATE LOOP
          UPDATE public.consent_record SET ended_at = now(), end_reason = 'superseded'
          WHERE id = c.id;
          PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_ended',
            p_context, NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object(
              'consentId', c.id, 'purpose', c.purpose, 'source', c.source), false);
        END LOOP;
      END IF;
      v_consent := pg_catalog.gen_random_uuid();
      v_text := 'kug200b-' || v_version || ':v1';
      INSERT INTO public.consent_record (id, project_id, participation_id, purpose, source,
        text_version, language, actor_type, actor_staff_user_id, given_on, document_id, ended_at,
        end_reason)
      VALUES (v_consent, d.project_id, d.participation_id, 'kug200b_profile_access', 'paper_form',
        v_text, 'de', 'user', (p_context).staff_user_id, p_signed_on, d.id,
        CASE WHEN NOT v_in_force THEN now() END,
        CASE WHEN NOT v_in_force THEN 'superseded'::public.consent_end_reason END);
      PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_given',
        p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
          'consentId', v_consent, 'purpose', 'kug200b_profile_access', 'textVersion', v_text,
          'language', 'de', 'source', 'paper_form'), false);
      -- An older paper is kept as history only, ended at once.
      IF NOT v_in_force THEN
        PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_ended',
          p_context, NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object(
            'consentId', v_consent, 'purpose', 'kug200b_profile_access', 'source', 'paper_form'),
          false);
      END IF;
    ELSE
      IF p_declarations ->> 'kind' = 'as_printed' THEN
        v_choice := g.jobboerse_choice::text;
        v_contact := CASE g.ba_contact_consent WHEN true THEN 'yes' WHEN false THEN 'no' END;
      ELSE
        v_choice := p_declarations ->> 'jobboerseChoice';
        v_contact := CASE (p_declarations ->> 'baContactConsent')::boolean
          WHEN true THEN 'yes' WHEN false THEN 'no' END;
      END IF;
      INSERT INTO public.signed_declaration (id, project_id, participation_id, document_id,
        form_code, form_version, declaration, value, signed_on, recorded_by)
      VALUES
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id,
          public.scan_form(d.type), v_version, 'jobboerseChoice', v_choice, v_signed_on,
          (p_context).staff_user_id),
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id,
          public.scan_form(d.type), v_version, 'baContactConsent', v_contact, v_signed_on,
          (p_context).staff_user_id);
      PERFORM public.write_audit_event(d.project_id, d.participation_id,
        'signed_declaration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('documentId', d.id, 'formCode', public.scan_form(d.type),
          'formVersion', v_version,
          'declarations', '["jobboerseChoice","baContactConsent"]'::jsonb), false);
    END IF;
  ELSE
    UPDATE public.document SET review_state = p_decision, review_reason = p_reason,
      reviewed_by = (p_context).staff_user_id, reviewed_at = now()
    WHERE id = d.id;
  END IF;
  IF d.type = 'dsv_signed_scan' AND v_accept THEN
    PERFORM public.sync_dsv_contract(d.dsv_offer_id);
  END IF;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_reviewed',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('documentId', d.id,
      'documentType', d.type, 'decision', p_decision, 'origin', d.scan_origin,
      'formVersion', CASE WHEN v_accept THEN v_version END,
      'termsConfirmed', CASE WHEN d.type = 'dsv_signed_scan' AND v_accept THEN coalesce((p_dsv->>'termsConfirmed')::boolean,false) END,
      'signatureKinds', CASE WHEN d.type IN ('dsv_signed_scan', 'dsv_cancellation') AND v_accept THEN (SELECT coalesce(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM jsonb_each(p_dsv->'signatures')) END)), false);
END $$;
--> statement-breakpoint

-- As 0096 wrote it plus the withdrawal of a signed DSV.
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

-- "Kunde informiert am" (process-and-lifecycle.md, the customer notice; Q46): the PL, once, for a
-- participation withdrawn on its signed DSV, not in the future and not before the withdrawal. The
-- customer whitelist (CLAUDE.md rule 6) is unchanged: the row says the PL told the customer.
CREATE FUNCTION public.record_customer_notice(p_context audit_context, p_participation_id uuid,
  p_notified_on date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF p_notified_on IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF EXISTS (SELECT FROM public.dsv_customer_notice WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'notice_recorded';
  END IF;
  IF r.status <> 'withdrawn' OR r.dsv_status <> 'dsv_signed' OR r.withdrawn_on IS NULL THEN
    RAISE EXCEPTION 'notice_not_due';
  END IF;
  IF p_notified_on > public.berlin_today() THEN RAISE EXCEPTION 'date_in_future'; END IF;
  IF p_notified_on < r.withdrawn_on THEN RAISE EXCEPTION 'notice_before_withdrawal'; END IF;
  INSERT INTO public.dsv_customer_notice (id, project_id, participation_id, notified_on, recorded_by)
  VALUES (v_id, r.project_id, r.id, p_notified_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_customer_notified', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('notifiedOn', p_notified_on), false);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.record_customer_notice FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_customer_notice TO transfer_app;
--> statement-breakpoint

-- As 0094 wrote it; the cancellation's document events are in the `dsv` stream too.
CREATE OR REPLACE FUNCTION audit_history(
  p_staff_session_hash text, p_participation_id uuid, p_before_seq bigint, p_limit integer,
  p_request_id text DEFAULT NULL
) RETURNS TABLE (seq bigint, occurred_at timestamptz, event_type audit_event_type,
  actor_type actor_type, actor_name text, system_job text, on_behalf boolean, field status_field,
  from_value text, to_value text, reason_code text, effective_date date, details jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_staff uuid;
  v_project uuid;
  v_roles text[];
  v_streams public.audit_stream[] := '{}';
  v_own public.audit_stream[] := '{}';
  v_known public.access_category[];
BEGIN
  IF p_participation_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_before_seq < 1 OR p_request_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT s.staff_user_id INTO v_staff
  FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id AND u.deactivated_at IS NULL
  WHERE s.token_hash = p_staff_session_hash AND s.ended_at IS NULL AND s.expires_at > now();
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  SELECT p.project_id INTO v_project FROM public.participation p WHERE p.id = p_participation_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_membership m
                 WHERE m.project_id = v_project AND m.staff_user_id = v_staff) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  -- The current memberships, the consultant only while assigned.
  v_roles := public.document_staff_roles(p_participation_id, v_staff);
  IF 'project_lead' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling,dsv}'::public.audit_stream[];
  END IF;
  IF 'consultant' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling}'::public.audit_stream[];
    v_own := '{dsv,payroll}';
  END IF;
  IF 'back_office' = ANY (v_roles) THEN
    v_streams := v_streams || '{dsv,payroll}'::public.audit_stream[];
  END IF;
  IF pg_catalog.cardinality(v_streams) = 0 THEN
    RAISE EXCEPTION 'not_assigned';
  END IF;
  v_known := ARRAY(SELECT DISTINCT k.access_category FROM public.role_field_knowledge k
                   WHERE k.project_role::text = ANY (v_roles));

  IF p_before_seq IS NULL THEN
    PERFORM public.write_audit_event(v_project, p_participation_id, 'audit_history_opened',
      ROW('user', v_staff, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb, false);
  END IF;

  RETURN QUERY
  SELECT e.seq, e.occurred_at, e.event_type, e.actor_type,
    CASE WHEN e.actor_type = 'user' THEN u.display_name END,
    e.system_job,
    e.on_behalf_of_participation_id IS NOT NULL,
    CASE WHEN pr.shows_change THEN e.field END,
    CASE WHEN pr.shows_change THEN e.from_value END,
    CASE WHEN pr.shows_change THEN e.to_value END,
    CASE WHEN pr.shows_reason THEN e.reason_code END,
    e.effective_date,
    public.audit_history_details(e.details, pr.detail_keys, v_known)
  FROM public.audit_event e
  JOIN public.audit_event_projection pr ON pr.event_type = e.event_type::text
    AND pr.field IS NOT DISTINCT FROM
      CASE WHEN e.event_type::text = 'status_changed' THEN e.field END
  LEFT JOIN public.staff_user u ON u.id = e.actor_staff_user_id
  WHERE e.participation_id = p_participation_id AND e.project_id = v_project
    AND (p_before_seq IS NULL OR e.seq < p_before_seq)
    AND ((CASE WHEN e.details->>'documentType' IN ('dsv_signed_scan', 'dsv_cancellation') THEN 'dsv'::public.audit_stream ELSE pr.stream END) = ANY (v_streams)
         OR (CASE WHEN e.details->>'documentType' IN ('dsv_signed_scan', 'dsv_cancellation') THEN 'dsv'::public.audit_stream ELSE pr.stream END) = ANY (v_own) AND e.actor_staff_user_id = v_staff)
  ORDER BY e.seq DESC
  LIMIT p_limit;
END $$;

