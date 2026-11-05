-- Hand-written (ADR-0002, profiling exceptions; process-and-lifecycle.md, profiling exceptions;
-- data-protection.md, exception evidence; D30, Q80, Q81, Q94, Q194, round 17): the evidence
-- records of a profiling exception, the evidence type's operations (document catalog version 7),
-- the request reading its record under the participation lock, the decision naming the record
-- the approver saw, the history's projection row and the grants. Same hardening as 0084: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. The enum and event type 0085 added are compared as text here, since this
-- runs after it in the same migration run.
--
-- Lock order (ADR-0002, D31): recording evidence and requesting take the project's shared advisory
-- lock and the participation row (`lock_participation`), then the evidence documents `FOR SHARE`
-- in id order; a decision takes the project's exclusive lock first, then the participation. No
-- setting is read: nothing to resolve.

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
    'ba_report_recorded', 'exception_evidence_recorded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): in the `profiling` stream with
-- the exception's events, by its kind only.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('exception_evidence_recorded', NULL, 'profiling', false, false, '{kind}');
--> statement-breakpoint

-- The field catalog's new key (the history's field categories): the structured BA confirmation.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('profilingExceptionEvidence', 'confidential');
--> statement-breakpoint

-- Document catalog version 7 (data-protection.md, documents; Q194): the exception evidence gets
-- its operations and becomes `signed` (normal mode only, never changed once reviewed). The PL
-- and the assigned consultant add and quarantine it, the assigned consultant reviews it, the PL
-- deletes it before its review. Its opening rights stay in the domain's catalog (the PL only in
-- assisted mode or through break-glass). Every other type as in version 6.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles)
SELECT type, 7, retention_class, file_name,
  CASE WHEN type::text = 'profiling_exception_evidence' THEN true ELSE signed END,
  generated,
  CASE WHEN type::text = 'profiling_exception_evidence' THEN '{consultant,project_lead}'
    ELSE add_roles END,
  CASE WHEN type::text = 'profiling_exception_evidence' THEN '{consultant}' ELSE review_roles END,
  CASE WHEN type::text = 'profiling_exception_evidence' THEN '{project_lead}' ELSE delete_roles END,
  open_roles,
  CASE WHEN type::text = 'profiling_exception_evidence' THEN '{consultant,project_lead}'
    ELSE quarantine_roles END
FROM document_type_policy WHERE catalog_version = 6;
--> statement-breakpoint

-- Defence in depth for "immutable evidence record" (round 16), whoever writes: never updated or
-- deleted.
CREATE FUNCTION profiling_exception_evidence_record_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'record_immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER profiling_exception_evidence_record_immutable
BEFORE UPDATE OR DELETE ON profiling_exception_evidence_record
FOR EACH ROW EXECUTE FUNCTION profiling_exception_evidence_record_immutable();
--> statement-breakpoint

-- A BA confirmation's reference as stored and fingerprinted (the domain's `normaliseBaReference`):
-- NFC, inner runs of spaces as one, no space at either end, lower case by ICU's root locale (as
-- JavaScript's `toLowerCase`), NFC again; null for a control character or nothing left.
CREATE FUNCTION normalise_ba_reference(p_reference text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_reference ~ '[[:cntrl:]]' THEN NULL ELSE NULLIF(
    pg_catalog.normalize(pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.normalize(p_reference, 'NFC'), ' {2,}', ' ', 'g'), ' ') COLLATE "und-x-icu"),
      'NFC'), '') END
$$;
--> statement-breakpoint

-- The fingerprint (round 17; the domain's `canonicalEvidence`, a test holds them equal):
-- `sha256:v1:` and the SHA-256 of the lines `profiling-exception-evidence:v1`, the participation
-- id, the kind, then the sorted, de-duplicated content digests or the confirmation's facts in key
-- order (`agenturKey=`, `confirmedOn=`, `reference=`), joined by line feeds, as UTF-8.
CREATE FUNCTION exception_evidence_fingerprint(
  p_participation_id uuid, p_kind exception_evidence_kind, p_digests text[], p_agentur_key text,
  p_reference text, p_confirmed_on date
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 'sha256:v1:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.array_to_string(
      ARRAY['profiling-exception-evidence:v1', p_participation_id::text, p_kind::text]
      || CASE p_kind::text
        WHEN 'documents' THEN ARRAY(SELECT u.d FROM (SELECT DISTINCT d
          FROM pg_catalog.unnest(p_digests) d) u ORDER BY u.d COLLATE "C")
        ELSE ARRAY['agenturKey=' || p_agentur_key,
          'confirmedOn=' || pg_catalog.to_char(p_confirmed_on, 'YYYY-MM-DD'),
          'reference=' || p_reference] END,
      E'\n'), 'UTF8')), 'hex')
$$;
--> statement-breakpoint

-- Whether a record's evidence still counts: a BA confirmation always; documents while each is
-- live, accepted, not quarantined and not invalidated. False for an unknown record.
CREATE FUNCTION exception_evidence_usable(p_record_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((
    SELECT CASE r.kind::text WHEN 'ba_confirmation' THEN true ELSE NOT EXISTS (
      SELECT FROM pg_catalog.unnest(r.document_ids) i
      LEFT JOIN public.document d ON d.id = i AND d.participation_id = r.participation_id
      WHERE d.id IS NULL OR d.deleted_at IS NOT NULL OR d.review_state::text <> 'accepted'
        OR d.quarantined_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL) END
    FROM public.profiling_exception_evidence_record r WHERE r.id = p_record_id), false)
$$;
--> statement-breakpoint

-- An evidence record (data-protection.md, exception evidence; D30): the PL of the participation's
-- project, as themselves (`actor_not_allowed` otherwise, on behalf of a participant too), while it
-- is `informed` (`not_informed`). Either documents: ids of this participation's
-- `profiling_exception_evidence` documents (`document_not_found` for any other id), each accepted,
-- live, not quarantined or invalidated (`evidence_missing`: a file's presence is no
-- verification), held `FOR SHARE` in id order; or a BA confirmation: the Agentur's key, the
-- reference (`reference_invalid` if nothing usable is left after normalisation or it is longer
-- than 100 characters) and the date, not after today in Berlin (`confirmation_in_future`). Any
-- other shape is `invalid_argument`. The record and its fingerprint are immutable; audited
-- `exception_evidence_recorded` with its id and kind, never its facts or fingerprint.
CREATE FUNCTION create_exception_evidence_record(
  p_context audit_context, p_participation_id uuid, p_kind exception_evidence_kind,
  p_document_ids uuid[], p_agentur_key text, p_reference text, p_confirmed_on date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  v_documents boolean := p_kind::text = 'documents';
  v_shape_ok boolean := CASE p_kind::text
    WHEN 'documents' THEN p_document_ids IS NOT NULL
      AND pg_catalog.cardinality(p_document_ids) BETWEEN 1 AND 20
      AND p_agentur_key IS NULL AND p_reference IS NULL AND p_confirmed_on IS NULL
    WHEN 'ba_confirmation' THEN p_document_ids IS NULL AND p_agentur_key IS NOT NULL
      AND p_reference IS NOT NULL AND p_confirmed_on IS NOT NULL
    ELSE false END;
  v_ids uuid[];
  v_digests text[] := '{}';
  v_reference text;
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_participation_id IS NULL OR NOT coalesce(v_shape_ok, false)
     OR v_documents AND pg_catalog.array_position(p_document_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(p_participation_id,
      (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status::text <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF v_documents THEN
    SELECT ARRAY(SELECT DISTINCT i FROM pg_catalog.unnest(p_document_ids) i ORDER BY i) INTO v_ids;
    FOR d IN SELECT * FROM public.document WHERE id = ANY (v_ids) ORDER BY id FOR SHARE LOOP
      IF d.participation_id <> p_participation_id
         OR d.type::text <> 'profiling_exception_evidence' THEN
        RAISE EXCEPTION 'document_not_found';
      END IF;
      IF d.deleted_at IS NOT NULL OR d.review_state::text <> 'accepted'
         OR d.quarantined_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL THEN
        RAISE EXCEPTION 'evidence_missing';
      END IF;
      v_digests := v_digests || d.content_sha256;
    END LOOP;
    IF pg_catalog.cardinality(v_digests) <> pg_catalog.cardinality(v_ids) THEN
      RAISE EXCEPTION 'document_not_found';
    END IF;
  ELSE
    v_reference := public.normalise_ba_reference(p_reference);
    IF v_reference IS NULL OR pg_catalog.char_length(v_reference) > 100 THEN
      RAISE EXCEPTION 'reference_invalid';
    END IF;
    IF p_confirmed_on > public.berlin_today() THEN
      RAISE EXCEPTION 'confirmation_in_future';
    END IF;
  END IF;
  INSERT INTO public.profiling_exception_evidence_record (id, project_id, participation_id, kind,
    document_ids, agentur_key, reference, confirmed_on, fingerprint, created_by, created_on)
  VALUES (v_id, r.project_id, p_participation_id, p_kind, v_ids, p_agentur_key, v_reference,
    p_confirmed_on, public.exception_evidence_fingerprint(p_participation_id, p_kind, v_digests,
      p_agentur_key, v_reference, p_confirmed_on),
    (p_context).staff_user_id, public.berlin_today());
  PERFORM public.write_audit_event(r.project_id, p_participation_id,
    'exception_evidence_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
    CASE WHEN v_documents
      THEN pg_catalog.jsonb_build_object('evidenceRecordId', v_id, 'kind', p_kind,
        'documentCount', pg_catalog.cardinality(v_ids))
      ELSE pg_catalog.jsonb_build_object('evidenceRecordId', v_id, 'kind', p_kind) END, false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The request (0004) reads its evidence record under the participation lock instead of taking a
-- fingerprint from its caller: the record of this participation (`evidence_missing` for any other
-- id), its evidence still usable (`evidence_missing`), a BA confirmation for
-- `ba_confirmed_other` (`ba_confirmation_missing`), and a fingerprint other than the latest
-- request's (`evidence_unchanged`: identical bytes under another id, another order or an equal
-- confirmation re-entered). The audit details stay round 17's: the request id and the opaque
-- record id, no fingerprint.
DROP FUNCTION request_profiling_exception(uuid, profiling_exception_reason, date, uuid, text,
  audit_context);
--> statement-breakpoint
CREATE FUNCTION request_profiling_exception(
  p_id uuid, p_reason profiling_exception_reason, p_requested_on date, p_evidence_record_id uuid,
  p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_latest public.profiling_exception_request;
  v_record public.profiling_exception_evidence_record;
  v_request_id uuid;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_reason IS NULL OR p_requested_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  SELECT * INTO v_latest FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  IF v_latest.status IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'exception_open';
  END IF;
  SELECT * INTO v_record FROM public.profiling_exception_evidence_record
  WHERE id = p_evidence_record_id AND participation_id = p_id;
  IF v_record.id IS NULL THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  -- The record's documents in id order, held while the request is written.
  PERFORM FROM public.document WHERE id = ANY (v_record.document_ids) ORDER BY id FOR SHARE;
  IF NOT public.exception_evidence_usable(v_record.id) THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  IF v_record.fingerprint = v_latest.evidence_fingerprint THEN
    RAISE EXCEPTION 'evidence_unchanged';
  END IF;
  IF p_reason = 'ba_confirmed_other' AND v_record.kind::text <> 'ba_confirmation' THEN
    RAISE EXCEPTION 'ba_confirmation_missing';
  END IF;
  INSERT INTO public.profiling_exception_request (
    project_id, participation_id, reason_code, status, requested_by, requested_on,
    evidence_record_id, evidence_fingerprint
  ) VALUES (
    r.project_id, p_id, p_reason, 'requested', (p_context).staff_user_id, p_requested_on,
    v_record.id, v_record.fingerprint
  ) RETURNING id INTO v_request_id;
  UPDATE public.participation
  SET profiling_exception_request_id = v_request_id, status_version = status_version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_requested', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    -- The opaque evidence record id only; the fingerprint stays on the request (round 17).
    jsonb_build_object('profilingExceptionRequestId', v_request_id,
      'evidenceRecordId', v_record.id), false);
  RETURN v_request_id;
END $$;
--> statement-breakpoint

-- The decision (0004) takes the project's exclusive lock first (D31), names the evidence record
-- the approver saw (`source_changed` if the request rests on another) and approves only while that
-- evidence is still usable (`evidence_missing`); a rejection needs no usable evidence. Four eyes,
-- the states and the audit as 0004 wrote them.
DROP FUNCTION decide_profiling_exception(uuid, boolean, date, audit_context);
--> statement-breakpoint
CREATE FUNCTION decide_profiling_exception(
  p_request_id uuid, p_approve boolean, p_decided_on date, p_evidence_record_id uuid,
  p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.profiling_exception_request;
  v_project_id uuid;
  v_document_ids uuid[];
  r public.participation;
BEGIN
  IF p_approve IS NULL OR p_decided_on IS NULL OR p_evidence_record_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.profiling_exception_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project_id));
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.evidence_record_id <> p_evidence_record_id THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'not_requested';
  END IF;
  IF v_request.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  SELECT document_ids INTO v_document_ids FROM public.profiling_exception_evidence_record
  WHERE id = p_evidence_record_id;
  PERFORM FROM public.document WHERE id = ANY (v_document_ids) ORDER BY id FOR SHARE;
  IF p_approve AND NOT public.exception_evidence_usable(p_evidence_record_id) THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  UPDATE public.profiling_exception_request SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.profiling_exception_status,
    decided_by = (p_context).staff_user_id,
    decided_on = p_decided_on,
    decided_at = now()
  WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id,
    CASE WHEN p_approve THEN 'profiling_exception_approved' ELSE 'profiling_exception_rejected' END::public.audit_event_type,
    p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $$;
--> statement-breakpoint

-- `record_audit_event` (0084) refuses the new type: only its function writes it.
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
      'exception_evidence_recorded') THEN
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

-- Grants: transfer_app selects the records (the kind and dates the views show; never written
-- directly) and executes the writes and the usability check; the helpers stay internal.
GRANT SELECT ON TABLE profiling_exception_evidence_record TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION profiling_exception_evidence_record_immutable, normalise_ba_reference, exception_evidence_fingerprint,
  exception_evidence_usable, create_exception_evidence_record, request_profiling_exception,
  decide_profiling_exception FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION exception_evidence_usable, create_exception_evidence_record,
  request_profiling_exception, decide_profiling_exception TO transfer_app;
