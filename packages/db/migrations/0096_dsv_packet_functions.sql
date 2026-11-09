-- The signed offer's contract and the complete packet (process-and-lifecycle.md, the DSV packet and
-- original; data-protection.md, DSV scans). Written only by the functions below (ADR-0002).
GRANT SELECT ON public.dsv_contract TO transfer_app;
CREATE UNIQUE INDEX dsv_contract_offer_once ON public.dsv_contract(dsv_offer_id);
ALTER TABLE public.dsv_contract ADD CONSTRAINT dsv_contract_participation_project_fk
  FOREIGN KEY (participation_id, project_id) REFERENCES participation(id, project_id);
ALTER TABLE public.dsv_contract ADD CONSTRAINT dsv_contract_original_location
  CHECK (original_location IS NULL OR original_location IN ('paper_personnel_file'));
ALTER TABLE public.dsv_contract ADD CONSTRAINT dsv_contract_roles CHECK (
  coalesce(received_by_role, participant_accepted_by_role, fully_executed_accepted_by_role, 'project_lead')
    IN ('project_lead', 'back_office')
  AND coalesce(participant_accepted_by_role, 'project_lead') IN ('project_lead', 'back_office')
  AND coalesce(fully_executed_accepted_by_role, 'project_lead') IN ('project_lead', 'back_office'));
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
    'evidence_correction_requested', 'evidence_correction_decided', 'dsv_form_generated', 'dsv_original_recorded'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES ('dsv_original_recorded', NULL, 'dsv', false, false, '{field,location}');
--> statement-breakpoint

-- Written only by `record_dsv_original` (ADR-0002); as 0090 wrote it plus the original's event.
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
      'evidence_correction_decided', 'dsv_form_generated', 'dsv_template_pinned', 'dsv_original_recorded') THEN
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

-- A participant date that differs from another accepted scan of the offer is refused: a wrong date
-- is corrected by a supersession, never by a second scan.
CREATE FUNCTION public.assert_dsv_participant_date(p_offer_id uuid, p_participant text, p_exclude uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_participant IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT FROM public.document d
      JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
      WHERE d.dsv_offer_id = p_offer_id AND d.review_state = 'accepted' AND d.deleted_at IS NULL
        AND d.id IS DISTINCT FROM p_exclude AND s.signed_on <> p_participant::date) THEN
    RAISE EXCEPTION 'signature_date_mismatch';
  END IF;
END $$;
--> statement-breakpoint

-- The facts of the counting scans (accepted, live, neither quarantined nor invalidated) of an open
-- or signed offer: the participant's signature, and `executed_on` (the latest of the three actual
-- dates) where the scan shows all three of a signed offer and its participant date is the offer's.
DROP FUNCTION public.dsv_facts(uuid[]);
CREATE FUNCTION public.dsv_facts(p_ids uuid[])
RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, signed_on date,
  recorded_at timestamptz, customer_signed_on date, tg_signed_on date, executed_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT d.participation_id, d.id, o.id, s.signed_on,
 greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at),
 c.signed_on, t.signed_on,
 CASE WHEN o.ended_as = 'signed' AND c.signed_on IS NOT NULL AND t.signed_on IS NOT NULL
   AND s.signed_on = (SELECT pg_catalog.min(x.signed_on) FROM public.dsv_scan_signature x
     JOIN public.document y ON y.id = x.document_id
     WHERE y.dsv_offer_id = o.id AND y.review_state = 'accepted' AND y.deleted_at IS NULL
       AND x.kind = 'participant')
 THEN greatest(s.signed_on, c.signed_on, t.signed_on) END
 FROM public.document d JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
 LEFT JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
 LEFT JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
 WHERE d.participation_id = ANY(p_ids) AND (o.ended_as IS NULL OR o.ended_as = 'signed')
 AND d.type = 'dsv_signed_scan' AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL AND d.dsv_received_on >= s.signed_on
$$;
REVOKE ALL ON FUNCTION public.dsv_facts FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dsv_facts TO transfer_app;
--> statement-breakpoint

-- The kind of project role a staff member holds for the participation now (the retained facts keep
-- the kind, never the person).
CREATE FUNCTION public.dsv_role_kind(p_participation_id uuid, p_staff_user_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT CASE WHEN 'project_lead' = ANY (r) THEN 'project_lead' WHEN 'back_office' = ANY (r) THEN 'back_office' END
 FROM (SELECT public.document_staff_roles(p_participation_id, p_staff_user_id) AS r) x
$$;
--> statement-breakpoint

-- The contract of a signed offer and the facts retained after the scans go. Each fact is set once,
-- when first established; a later quarantine or invalidation withholds the fact for the guards but
-- never rewrites what happened. Internal: runs as its definer-function callers (the status function
-- and the review) and has no grant of its own.
CREATE FUNCTION public.sync_dsv_contract(p_offer_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.dsv_offer; a record; b record;
BEGIN
  SELECT * INTO o FROM public.dsv_offer WHERE id = p_offer_id AND ended_as = 'signed';
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.dsv_contract(project_id, participation_id, dsv_offer_id)
  VALUES (o.project_id, o.participation_id, o.id) ON CONFLICT (dsv_offer_id) DO NOTHING;
  PERFORM FROM public.dsv_contract WHERE dsv_offer_id = o.id FOR UPDATE;
  SELECT f.signed_on, d.reviewed_at, d.reviewed_by, d.dsv_received_on, d.dsv_received_by INTO a
  FROM public.dsv_facts(ARRAY[o.participation_id]) f JOIN public.document d ON d.id = f.document_id
  WHERE f.offer_id = o.id ORDER BY f.recorded_at, f.document_id LIMIT 1;
  SELECT f.customer_signed_on, f.tg_signed_on, f.executed_on, d.reviewed_at, d.reviewed_by INTO b
  FROM public.dsv_facts(ARRAY[o.participation_id]) f JOIN public.document d ON d.id = f.document_id
  WHERE f.offer_id = o.id AND f.executed_on IS NOT NULL ORDER BY f.recorded_at, f.document_id LIMIT 1;
  UPDATE public.dsv_contract c SET
    participant_signed_on = coalesce(c.participant_signed_on, a.signed_on),
    participant_accepted_on = coalesce(c.participant_accepted_on,
      (a.reviewed_at AT TIME ZONE 'Europe/Berlin')::date),
    participant_accepted_by_role = coalesce(c.participant_accepted_by_role,
      public.dsv_role_kind(o.participation_id, a.reviewed_by)),
    received_on = coalesce(c.received_on, a.dsv_received_on),
    received_by_role = coalesce(c.received_by_role,
      public.dsv_role_kind(o.participation_id, a.dsv_received_by)),
    customer_signed_on = coalesce(c.customer_signed_on, b.customer_signed_on),
    tg_signed_on = coalesce(c.tg_signed_on, b.tg_signed_on),
    fully_executed_on = coalesce(c.fully_executed_on, b.executed_on),
    fully_executed_accepted_on = coalesce(c.fully_executed_accepted_on,
      (b.reviewed_at AT TIME ZONE 'Europe/Berlin')::date),
    fully_executed_accepted_by_role = coalesce(c.fully_executed_accepted_by_role,
      public.dsv_role_kind(o.participation_id, b.reviewed_by))
  WHERE c.dsv_offer_id = o.id;
END $$;
--> statement-breakpoint

-- The original of the signed contract (PL and back office; not a guard, Q71): changed only against
-- the value read (`stale_value`), dates not in the future, the location controlled. Audited by the
-- field and the location code only.
CREATE FUNCTION public.record_dsv_original(p_context audit_context, p_participation_id uuid,
  p_field text, p_value text, p_expected text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; c public.dsv_contract; v_current text;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF p_field IS NULL OR p_field NOT IN ('originalLocation', 'originalReceivedOn', 'sentToCustomerOn')
     OR p_value IS NULL
     OR p_field = 'originalLocation' AND p_value <> 'paper_personnel_file'
     OR p_field <> 'originalLocation' AND p_value !~ '^\d{4}-\d{2}-\d{2}$'
     OR p_expected IS NOT NULL AND p_field = 'originalLocation' AND p_expected <> 'paper_personnel_file'
     OR p_expected IS NOT NULL AND p_field <> 'originalLocation' AND p_expected !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO c FROM public.dsv_contract WHERE participation_id = r.id
  ORDER BY created_at DESC, id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF p_field <> 'originalLocation' AND p_value::date > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  v_current := CASE p_field WHEN 'originalLocation' THEN c.original_location
    WHEN 'originalReceivedOn' THEN c.original_received_on::text ELSE c.sent_to_customer_on::text END;
  IF v_current IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'stale_value'; END IF;
  IF v_current = p_value THEN RAISE EXCEPTION 'value_unchanged'; END IF;
  UPDATE public.dsv_contract SET
    original_location = CASE WHEN p_field = 'originalLocation' THEN p_value ELSE original_location END,
    original_received_on = CASE WHEN p_field = 'originalReceivedOn' THEN p_value::date ELSE original_received_on END,
    sent_to_customer_on = CASE WHEN p_field = 'sentToCustomerOn' THEN p_value::date ELSE sent_to_customer_on END
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_original_recorded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('field', p_field,
      'location', CASE WHEN p_field = 'originalLocation' THEN p_value END)), false);
END $$;
--> statement-breakpoint

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
  IF (p_type = 'dsv_signed_scan') <> (p_dsv IS NOT NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF p_dsv IS NOT NULL THEN
    PERFORM FROM public.dsv_offer WHERE id = (p_dsv->>'offerId')::uuid AND participation_id = p_participation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
    -- The open offer takes the participant's paper; the signed offer also the countersigned original.
    IF NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = (p_dsv->>'offerId')::uuid AND (ended_as IS NULL OR ended_as = 'signed')) THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF NOT EXISTS (SELECT FROM public.staff_user WHERE id = (p_dsv->>'receivedBy')::uuid) THEN RAISE EXCEPTION 'receiver_required'; END IF;
    PERFORM public.validate_dsv_scan(p_dsv->'signatures', (p_dsv->>'receivedOn')::date);
    PERFORM public.assert_dsv_participant_date((p_dsv->>'offerId')::uuid, p_dsv->'signatures'->>'participant', NULL);
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
  IF (d.type = 'dsv_signed_scan' AND v_accept) <> (p_dsv IS NOT NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
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
      'signatureKinds', CASE WHEN d.type = 'dsv_signed_scan' AND v_accept THEN (SELECT coalesce(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM jsonb_each(p_dsv->'signatures')) END)), false);
END $$;
--> statement-breakpoint
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
REVOKE ALL ON FUNCTION public.assert_dsv_participant_date, public.dsv_role_kind,
  public.sync_dsv_contract, public.record_dsv_original FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_dsv_original TO transfer_app;
--> statement-breakpoint

-- Offers signed before the contract existed get theirs from the scans that supported the signature
-- (no date is invented: a packet is not retained unless a scan already showed all three).
SELECT public.sync_dsv_contract(id) FROM public.dsv_offer WHERE ended_as = 'signed';
