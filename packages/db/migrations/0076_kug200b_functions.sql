-- Hand-written (ADR-0002, the Kug 200b; process-and-lifecycle.md, the Kug 200b offer;
-- data-protection.md, generated forms, signed scans, signed declarations and exports; Q179,
-- Q184, Q185, Q197): the document type catalog's version 6 with the generated Kug 200b and the
-- signed Kug 200b's operations, the five document functions 0075 dropped with the recreated
-- `document_type`, the Kug 200b's generation (one, and 1–100 under the exclusive project lock) with
-- its purpose-bound read of the values it prints, its review with the three confirmations, the
-- signed declarations 16 and 17 and the consent record of declaration 17, the offer's decline, a
-- withdrawal and its "BA informiert am", the export link and its re-authorized content, the
-- history's projection rows and the grants. Same hardening as 0074: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. Audit details carry ids, codes, counts and dates only. The event types and the document
-- type 0075 added are compared as text here, since this runs after it in the same migration run.
--
-- Lock order (ADR-0002, the Kug 200b): the project's advisory lock (shared through
-- `lock_participation`; exclusive for a bulk generation, taken first), the participation rows in
-- UUID order, then the documents (`FOR SHARE` the generation a scan names, `FOR UPDATE` the one
-- changed), `asu_record`, the decline, the consent rows and the withdrawal, then the sensitive
-- rows. Staff act as themselves in normal mode; assisted mode and break-glass grant nothing here.

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
    'declaration_withdrawal_ba_notified'));
--> statement-breakpoint
-- An export is project-level: never a participation's.
ALTER TABLE audit_event ADD CONSTRAINT audit_event_export_of_project CHECK (
  participation_id IS NULL OR event_type::text NOT IN ('export_created', 'export_downloaded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): the offer's events by their
-- dates in the `case` stream; a consent names its source; the download is security, never shown.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('kug200b_offer_declined', NULL, 'case', false, false, '{declinedOn}'),
  ('declaration_withdrawal_recorded', NULL, 'case', false, false, '{receivedOn}'),
  ('declaration_withdrawal_ba_notified', NULL, 'case', false, false, '{notifiedOn}'),
  ('export_downloaded', NULL, 'security', false, false, '{}');
--> statement-breakpoint
UPDATE audit_event_projection SET detail_keys = '{purpose,textVersion,source}'
WHERE event_type::text = 'consent_given';
--> statement-breakpoint
UPDATE audit_event_projection SET detail_keys = '{purpose,source}'
WHERE event_type::text = 'consent_ended';
--> statement-breakpoint

-- The field catalog's new key (the history's field categories): the Kug 200b offer.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('kug200bOffer', 'case_internal');
--> statement-breakpoint

-- Catalog version 6 (packages/domain/src/documents/catalog.ts): version 5's rows, the signed
-- Kug 200b with the signed TL 407's operations (Q184): added and reviewed by the assigned
-- consultant and the PL, quarantined by either, deleted by the PL before its review; and the
-- generated Kug 200b (`kug200b_form`): the signed type's open roles, the working copy's class, no
-- add, review or delete role (`generated`). Documents of earlier versions keep their rows.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles)
SELECT type, 6, retention_class, file_name, signed, generated,
  CASE WHEN type::text = 'kug200b_signed_scan' THEN '{consultant,project_lead}' ELSE add_roles END,
  CASE WHEN type::text = 'kug200b_signed_scan' THEN '{consultant,project_lead}'
    ELSE review_roles END,
  CASE WHEN type::text = 'kug200b_signed_scan' THEN '{project_lead}' ELSE delete_roles END,
  open_roles,
  CASE WHEN type::text = 'kug200b_signed_scan' THEN '{consultant,project_lead}'
    ELSE quarantine_roles END
FROM document_type_policy WHERE catalog_version = 5;
--> statement-breakpoint
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles) VALUES
  ('kug200b_form', 6, 'form_working_copy', false, false, true, '{}', '{}', '{}',
    '{consultant,project_lead}', '{}');
--> statement-breakpoint

-- Created again with the recreated type, as 0070 and 0072 wrote them.

-- The policy a new document of the type gets: the type's row of the latest catalog version.
CREATE FUNCTION current_document_policy(p_type document_type)
RETURNS document_type_policy LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM public.document_type_policy WHERE type = p_type
  ORDER BY catalog_version DESC LIMIT 1
$$;
--> statement-breakpoint

-- The form a signed scan type is of (the domain's `scanForms`); null for any other type.
CREATE FUNCTION scan_form(p_type document_type)
RETURNS form_code LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_type::text
    WHEN 'tl407_signed_scan' THEN 'tl407'::public.form_code
    WHEN 'kug200b_signed_scan' THEN 'kug200b'::public.form_code END
$$;
--> statement-breakpoint

-- An upload stored (data-protection.md, uploads and signed scans; Q143, Q146, Q184), as 0072
-- wrote it: a scan type names its origin; `generated` a generation of the same participation and
-- form, held `FOR SHARE`.
CREATE FUNCTION add_document(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_type document_type,
  p_media_type document_media_type, p_size_bytes integer, p_content_sha256 text,
  p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL,
  p_scan_origin scan_origin DEFAULT NULL, p_generation_document_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
    form_code, form_version)
  VALUES (p_id, v_project_id, p_participation_id, p_type, pol.catalog_version,
    pol.retention_class, p_media_type, p_size_bytes, p_content_sha256, p_file_name, p_key_id,
    p_wrapped_key, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).on_behalf_of IS NOT NULL, p_scan_origin, p_generation_document_id,
    CASE WHEN v_version IS NOT NULL THEN v_form END, v_version);
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'document_added', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_id,
      'documentType', p_type, 'source', CASE
        WHEN (p_context).actor_type = 'participant' THEN 'portal'
        WHEN (p_context).on_behalf_of IS NOT NULL THEN 'assisted'
        ELSE 'staff' END), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- An upload the scan refused (Q144), as 0070 wrote it.
CREATE FUNCTION record_document_upload_rejected(
  p_context audit_context, p_participation_id uuid, p_type document_type, p_code text,
  p_token_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pol public.document_type_policy := public.current_document_policy(p_type);
  v_roles text[];
BEGIN
  IF p_type IS NULL OR p_code IS NULL OR p_code NOT IN ('file_infected', 'file_unscannable') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(p_participation_id, p_context, p_token_hash, true);
  IF pg_catalog.cardinality(pol.add_roles) = 0 THEN
    RAISE EXCEPTION 'document_type_not_supported';
  END IF;
  IF NOT v_roles && pol.add_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.write_audit_event(
    (SELECT project_id FROM public.participation WHERE id = p_participation_id),
    p_participation_id, 'document_upload_rejected', p_context, NULL, NULL, NULL, p_code, NULL,
    pg_catalog.jsonb_build_object('documentType', p_type), false);
END $$;
--> statement-breakpoint

-- A link's content (Q147), as 0072 wrote it; never a quarantined document's.
CREATE FUNCTION document_link_content(
  p_link_hash text, p_session_kind document_session_kind, p_session_hash text
) RETURNS TABLE (
  document_id uuid, participation_id uuid, document_type document_type,
  media_type document_media_type, file_name text, key_id text, wrapped_key bytea,
  added_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT d.id, d.participation_id, d.type, d.media_type, d.file_name, d.key_id, d.wrapped_key,
    d.added_at
  FROM public.document_link l
  JOIN public.document d ON d.id = l.document_id
  WHERE l.token_hash = p_link_hash AND l.session_kind = p_session_kind
    AND l.session_hash = p_session_hash AND l.expires_at > now() AND d.deleted_at IS NULL
    AND d.quarantined_at IS NULL
    AND CASE p_session_kind
      WHEN 'participant' THEN EXISTS (
        SELECT FROM public.participant_session s
        WHERE s.token_hash = p_session_hash AND s.state = 'active'
          AND public.participant_session_live(s))
      ELSE EXISTS (
        SELECT FROM public.staff_session s
        JOIN public.staff_user u ON u.id = s.staff_user_id
        WHERE s.token_hash = p_session_hash AND s.ended_at IS NULL AND s.expires_at > now()
          AND u.deactivated_at IS NULL)
    END
$$;
--> statement-breakpoint

-- Internal helpers (no grant).

-- The actor of a Kug 200b operation (data-protection.md, generated forms; process-and-lifecycle.md,
-- the Kug 200b offer): a staff user acting for themselves (`actor_not_allowed` in assisted mode or
-- without the PL or the assigned consultant's role, `document_staff_roles`), the participation
-- locked (the shared project lock first), a `ta_tg` project (`asu_not_applicable`, Q89) and, with
-- `p_open`, an open participation (`participation_closed`); a withdrawal and its BA notice are
-- recorded after the end too. Returns the locked participation.
CREATE FUNCTION lock_kug200b_actor(p_participation_id uuid, p_context audit_context, p_open boolean)
RETURNS participation LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id)
     && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  IF p_open AND r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- A Kug 200b's checklist as stored (Q197 (8)): `[{code, key}]`, the codes `required_blank` and
-- `text_not_fitting`, a key of field-key characters; no value.
CREATE FUNCTION form_checklist_valid(p_checklist jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_checklist) = 'array'
    AND pg_catalog.jsonb_array_length(p_checklist) <= 50
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_array_elements(p_checklist) e(v)
      WHERE pg_catalog.jsonb_typeof(v) <> 'object'
        OR ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(v) k ORDER BY k) <> '{code,key}'::text[]
        OR v ->> 'code' NOT IN ('required_blank', 'text_not_fitting')
        OR v ->> 'key' !~ '^[A-Za-z][A-Za-z0-9_.]{0,99}$'), false)
$$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A generated form stored (data-protection.md, generated forms; Q179), as 0070 wrote it for the
-- TL 407, and the Kug 200b's: the PL or the assigned consultant (`lock_kug200b_actor`: a `ta_tg`
-- project, an open participation), no declaration snapshot (`p_declarations` null), no confirmed
-- warning, no Anlage, and its handwriting checklist (`p_checklist`, `form_checklist_valid`); its
-- sources (the profile's revision, which the sensitive answers' writes move too, the person
-- printed and the employer printed, `p_employer_sha256` of the project's customer name, which a
-- project change writes under the exclusive project lock) are compared again under the lock
-- (`source_changed`). The TL 407 takes neither the checklist nor the employer
-- (`invalid_argument`). Audited `form_generated` and, for the TL 407, one
-- `warning_confirmed` per confirmed code. Returns the generation's id.
DROP FUNCTION "public"."record_form_generation"("public"."audit_context", uuid, uuid, uuid, "public"."form_code", text, jsonb, jsonb, text, text, jsonb, text[], boolean, integer, text, text, bytea);
--> statement-breakpoint
CREATE FUNCTION record_form_generation(
  p_context audit_context, p_participation_id uuid, p_generation_id uuid, p_document_id uuid,
  p_form_code form_code, p_form_version text, p_sources jsonb, p_person jsonb,
  p_source_token text, p_organisation_sha256 text, p_declarations jsonb,
  p_confirmed_warnings text[], p_anlage boolean, p_size_bytes integer, p_content_sha256 text,
  p_key_id text, p_wrapped_key bytea, p_checklist jsonb DEFAULT NULL,
  p_employer_sha256 text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kug boolean := p_form_code = 'kug200b';
  pol public.document_type_policy;
  r public.participation;
  pr public.participant_profiling;
  v_profile integer;
  v_assessment integer;
  v_unemployment integer;
  v_code text;
BEGIN
  IF p_generation_id IS NULL OR p_document_id IS NULL OR p_form_code IS NULL
     OR p_form_version IS NULL OR p_form_version !~ '^(0[1-9]|1[0-2])-[0-9]{4}$'
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
  IF p_form_code NOT IN ('tl407', 'kug200b') THEN
    RAISE EXCEPTION 'form_not_supported';
  END IF;
  IF v_kug AND (p_declarations IS NOT NULL OR pg_catalog.cardinality(p_confirmed_warnings) > 0
       OR p_anlage OR NOT public.form_checklist_valid(p_checklist)
       OR p_employer_sha256 IS NULL OR p_employer_sha256 !~ '^[0-9a-f]{64}$')
     OR NOT v_kug AND (p_checklist IS NOT NULL OR p_employer_sha256 IS NOT NULL
       OR NOT public.form_declarations_valid(p_declarations)) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  pol := public.current_document_policy(
    CASE WHEN v_kug THEN 'kug200b_form' ELSE 'tl407_form' END::public.document_type);
  IF v_kug THEN
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
     OR v_kug AND (SELECT pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(p.customer_name, 'UTF8')), 'hex')
       FROM public.project p WHERE p.id = r.project_id) IS DISTINCT FROM p_employer_sha256
     OR NOT v_kug AND (coalesce(pr.revision, 0) <> (p_sources ->> 'profiling')::integer
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
    ba_contact_consent, confirmed_warnings, anlage, checklist, generated_by)
  VALUES (p_generation_id, r.project_id, r.id, p_document_id, p_form_code, p_form_version,
    (p_sources ->> 'profile')::integer, (p_sources ->> 'profiling')::integer,
    (p_sources ->> 'assessment')::integer, (p_sources ->> 'unemployment')::integer,
    p_source_token, p_organisation_sha256,
    CASE WHEN NOT v_kug THEN pr.jobboerse_choice END,
    CASE WHEN NOT v_kug THEN pr.ba_contact_consent END,
    p_confirmed_warnings, p_anlage, p_checklist, (p_context).staff_user_id);
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

-- A bulk Kug 200b generation's locks (data-protection.md, generated forms; Q179): the PL of the
-- project as themselves (`actor_not_allowed`), a `ta_tg` project (`asu_not_applicable`), 1–100
-- distinct participations of it (`invalid_argument`, `participation_not_found`). Takes the
-- project's exclusive advisory lock, then the participation rows in UUID order; the caller then
-- records each generation with `record_form_generation` in the same transaction, all or nothing.
CREATE FUNCTION lock_bulk_form_generation(
  p_context audit_context, p_project_id uuid, p_participation_ids uuid[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_project_id IS NULL OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 100
     OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_participation_ids) i)
       <> pg_catalog.cardinality(p_participation_ids)
     OR pg_catalog.array_position(p_participation_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role = 'project_lead') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) IS DISTINCT FROM 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF (SELECT pg_catalog.count(*) FROM public.participation
      WHERE id = ANY (p_participation_ids) AND project_id = p_project_id)
     <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM FROM public.participation WHERE id = ANY (p_participation_ids) ORDER BY id FOR UPDATE;
END $$;
--> statement-breakpoint

-- The values a Kug 200b prints from the sensitive answers (ba-forms.md, what is filled: 10 the
-- nationality, 11 the RV-Nummer, 12 the Schwerbehinderung): a read bound to the generation's
-- purpose for the PL or the assigned consultant (`lock_kug200b_actor`, also the PL, who doesn't
-- read these fields elsewhere: the values go only into the form they generate and may open, Q49,
-- Q179), each key read audited `sensitive_read`. `p_keys` the present ones of the three.
CREATE FUNCTION read_kug200b_values(
  p_participation_id uuid, p_context audit_context, p_keys text[], p_key text, p_key_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_all jsonb;
  v_result jsonb := '{}';
  k text;
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) = 0
     OR NOT p_keys <@ '{nationality,pensionInsuranceNumber,severeDisability}'::text[]
     OR (SELECT pg_catalog.count(DISTINCT f) FROM pg_catalog.unnest(p_keys) f)
       <> pg_catalog.cardinality(p_keys)
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  v_all := public.open_sensitive_fields(r.id, p_key, p_key_id);
  FOREACH k IN ARRAY p_keys LOOP
    v_result := v_result || pg_catalog.jsonb_build_object(k, v_all -> k);
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_read', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', k), false);
  END LOOP;
  RETURN v_result;
END $$;
--> statement-breakpoint

-- A review (process-and-lifecycle.md, document review; Q146), as 0072 wrote it, and the signed
-- Kug 200b's (data-protection.md, signed scans and signed declarations; Q184, Q185): not while
-- quarantined, not after the end. Its acceptance takes the date written in field 19
-- (`p_signed_on`, not after today, for a generated scan not before its generation), all three
-- confirmations (16 and 17 ticked, the mandatory information completed, signed), for external paper
-- the version named, and no second date or declarations (`invalid_argument`). It records the
-- signed declarations 16 and 17 (`yes`, audited `signed_declaration_recorded`) and declaration 17
-- as written as one consent record (purpose `kug200b_profile_access`, source `paper_form`, text
-- `kug200b-<version>:v1`, `de`, given on the field-19 date, the scan, recorded by the reviewer;
-- audited `consent_given`). Which record is in force follows the dates, not the order of
-- acceptance: the new one only if its date is after every withdrawal received and not before a
-- record in force whose paper is usable (live, not quarantined or invalidated); the earlier
-- records still in force then end `superseded` (`consent_ended`), so one is in force. Otherwise the
-- older paper is kept as history: its record is ended `superseded` at once (`consent_ended`), and a
-- renewed declaration needs a later paper. The TL 407 as 0072 wrote it.
CREATE OR REPLACE FUNCTION review_document(
  p_context audit_context, p_document_id uuid, p_decision document_review_state,
  p_reason document_review_reason, p_signed_on date DEFAULT NULL,
  p_countersigned_on date DEFAULT NULL, p_confirmations text[] DEFAULT NULL,
  p_form_version text DEFAULT NULL, p_declarations jsonb DEFAULT NULL
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
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_reviewed',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('documentId', d.id,
      'documentType', d.type, 'decision', p_decision, 'origin', d.scan_origin,
      'formVersion', CASE WHEN v_accept THEN v_version END)), false);
END $$;
--> statement-breakpoint

-- The offer declined (process-and-lifecycle.md, the Kug 200b offer; Q185): the PL or the assigned
-- consultant of an open `ta_tg` participation, with the date (not after today in Berlin,
-- `declined_on_in_future`); once (`kug200b_declined`); not once signed (`kug200b_signed`, a usable
-- accepted scan: a withdrawal is the way then); not on the route `kug_200b`
-- (`asu_route_kug200b`: the route changes first, so a declined offer is never missing). It
-- touches no registration. Audited `kug200b_offer_declined`.
CREATE FUNCTION decline_kug200b_offer(
  p_context audit_context, p_participation_id uuid, p_declined_on date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation;
BEGIN
  IF p_participation_id IS NULL OR p_declined_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  IF EXISTS (SELECT FROM public.document d
             WHERE d.participation_id = r.id AND d.type = 'kug200b_signed_scan'
               AND d.review_state = 'accepted' AND d.deleted_at IS NULL
               AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL) THEN
    RAISE EXCEPTION 'kug200b_signed';
  END IF;
  IF (SELECT channel FROM public.asu_record WHERE participation_id = r.id FOR SHARE)
     IS NOT DISTINCT FROM 'kug_200b' THEN
    RAISE EXCEPTION 'asu_route_kug200b';
  END IF;
  IF EXISTS (SELECT FROM public.kug200b_decline WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'kug200b_declined';
  END IF;
  IF p_declined_on > public.berlin_today() THEN
    RAISE EXCEPTION 'declined_on_in_future';
  END IF;
  INSERT INTO public.kug200b_decline (participation_id, project_id, declined_on, declined_by)
  VALUES (r.id, r.project_id, p_declined_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'kug200b_offer_declined', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('declinedOn',
      pg_catalog.to_char(p_declined_on, 'YYYY-MM-DD')), false);
END $$;
--> statement-breakpoint

-- A written withdrawal of declaration 17 that reached the TG (Q185): the PL or the assigned
-- consultant, also after the participation's end, with the record it ends (purpose
-- `kug200b_profile_access`, in force: `consent_not_found`, `consent_ended`) and the date received
-- (not after today, `received_on_in_future`; not before the date written on the paper,
-- `received_before_consent`). Ends the record `revoked` (`consent_ended`) and opens the BA notice;
-- it touches no registration and claims nothing about the BA's systems. Audited
-- `declaration_withdrawal_recorded`. Returns the withdrawal's id.
CREATE FUNCTION record_declaration_withdrawal(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_consent_id uuid,
  p_received_on date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  c public.consent_record;
BEGIN
  IF p_participation_id IS NULL OR p_id IS NULL OR p_consent_id IS NULL
     OR p_received_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, false);
  SELECT * INTO c FROM public.consent_record
  WHERE id = p_consent_id AND participation_id = r.id AND purpose = 'kug200b_profile_access'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consent_not_found';
  END IF;
  IF c.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'consent_ended';
  END IF;
  IF p_received_on > public.berlin_today() THEN
    RAISE EXCEPTION 'received_on_in_future';
  END IF;
  IF p_received_on < c.given_on THEN
    RAISE EXCEPTION 'received_before_consent';
  END IF;
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'revoked' WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'consent_ended', p_context, NULL, NULL,
    NULL, 'revoked', NULL, pg_catalog.jsonb_build_object('consentId', c.id, 'purpose',
      c.purpose, 'source', c.source), false);
  INSERT INTO public.kug200b_withdrawal (id, project_id, participation_id, consent_id,
    received_on, recorded_by)
  VALUES (p_id, r.project_id, r.id, c.id, p_received_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'declaration_withdrawal_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('withdrawalId', p_id,
      'consentId', c.id, 'receivedOn', pg_catalog.to_char(p_received_on, 'YYYY-MM-DD')), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- "BA informiert am" (Q185): the PL or the assigned consultant, also after the end, once per
-- withdrawal (`withdrawal_not_found`, `ba_notice_recorded`), the date not after today
-- (`notified_on_in_future`) and not before the receipt (`notified_before_receipt`). Closes the
-- item; it records that the BA was told, never that its access was disabled. Audited
-- `declaration_withdrawal_ba_notified`.
CREATE FUNCTION record_withdrawal_ba_notice(
  p_context audit_context, p_participation_id uuid, p_withdrawal_id uuid, p_notified_on date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  w public.kug200b_withdrawal;
BEGIN
  IF p_participation_id IS NULL OR p_withdrawal_id IS NULL OR p_notified_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, false);
  SELECT * INTO w FROM public.kug200b_withdrawal
  WHERE id = p_withdrawal_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal_not_found';
  END IF;
  IF w.ba_notified_on IS NOT NULL THEN
    RAISE EXCEPTION 'ba_notice_recorded';
  END IF;
  IF p_notified_on > public.berlin_today() THEN
    RAISE EXCEPTION 'notified_on_in_future';
  END IF;
  IF p_notified_on < w.received_on THEN
    RAISE EXCEPTION 'notified_before_receipt';
  END IF;
  UPDATE public.kug200b_withdrawal SET ba_notified_on = p_notified_on,
    ba_notified_by = (p_context).staff_user_id, ba_notified_at = now()
  WHERE id = w.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'declaration_withdrawal_ba_notified',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('withdrawalId', w.id,
      'notifiedOn', pg_catalog.to_char(p_notified_on, 'YYYY-MM-DD')), false);
END $$;
--> statement-breakpoint

-- Whether a staff user sees one document for an export (data-protection.md, exports): a live
-- generated Kug 200b of a participation the user may open it on (the policy's open roles, a
-- consultant only while assigned, `document_staff_roles`). What isn't visible is never told apart
-- by its state.
CREATE FUNCTION export_document_visible(p_document document, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_document.type::text = 'kug200b_form' AND p_document.deleted_at IS NULL
    AND public.document_staff_roles(p_document.participation_id, p_staff_user_id)
      && (SELECT t.open_roles FROM public.document_type_policy t
          WHERE t.type = p_document.type AND t.catalog_version = p_document.catalog_version),
    false)
$$;
--> statement-breakpoint

-- Whether a staff user may export one document now: visible, and neither quarantined nor
-- invalidated.
CREATE FUNCTION export_document_allowed(p_document document, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.export_document_visible(p_document, p_staff_user_id)
    AND p_document.quarantined_at IS NULL AND p_document.invalidated_by_correction IS NULL
$$;
--> statement-breakpoint

-- An export issued (data-protection.md, exports; ADR-0010): staff as themselves through their
-- live session (`session_invalid`; in assisted mode `actor_not_allowed`), the kind `kug200b_print`
-- over 1–100 distinct generated Kug 200b forms. Visibility comes before any state: a form that
-- doesn't exist, is deleted, of another type or not the user's to open is `document_not_found`,
-- whatever its state; only then forms of more than one project (`invalid_argument`), quarantined
-- (`document_quarantined`) or invalidated (`document_invalidated`). Stores the link's hash bound
-- to the session, valid 60 s, the documents fixed; no file. Audited `export_created` (kind and count, project-level, never the ids).
-- Returns the expiry.
CREATE FUNCTION create_export_link(
  p_context audit_context, p_kind export_kind, p_document_ids uuid[], p_session_hash text,
  p_link_hash text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_project_id uuid;
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_kind IS NULL OR p_document_ids IS NULL
     OR pg_catalog.cardinality(p_document_ids) NOT BETWEEN 1 AND 100
     OR pg_catalog.array_position(p_document_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_document_ids) i)
       <> pg_catalog.cardinality(p_document_ids)
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document x
      WHERE x.id = ANY (p_document_ids)
        AND public.export_document_visible(x, (p_context).staff_user_id))
     <> pg_catalog.cardinality(p_document_ids) THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT project_id) FROM public.document
      WHERE id = ANY (p_document_ids)) <> 1 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  FOR d IN SELECT * FROM public.document WHERE id = ANY (p_document_ids) ORDER BY id LOOP
    v_project_id := d.project_id;
    IF d.quarantined_at IS NOT NULL THEN
      RAISE EXCEPTION 'document_quarantined';
    END IF;
    IF d.invalidated_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'document_invalidated';
    END IF;
  END LOOP;
  INSERT INTO public.export_link (token_hash, project_id, kind, document_ids, staff_user_id,
    session_hash, expires_at)
  VALUES (p_link_hash, v_project_id, p_kind, p_document_ids, (p_context).staff_user_id,
    p_session_hash, v_expires);
  PERFORM public.write_audit_event(v_project_id, NULL, 'export_created', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', p_kind,
      'count', pg_catalog.cardinality(p_document_ids)), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- An export's content (data-protection.md, exports): only a live link (not expired) of this staff
-- user and session, the session still live and the account active (`export_link_invalid`, a 404),
-- and every document **re-authorized** now: still live, not quarantined or invalidated, and the
-- user's to open (`export_stale`). The documents in the link's order, with what decrypts them; the
-- API renders and streams the output and stores nothing. Audited `export_downloaded` (kind and
-- count) on every download.
CREATE FUNCTION export_link_content(
  p_context audit_context, p_link_hash text, p_session_hash text
) RETURNS TABLE (
  document_id uuid, participation_id uuid, document_type document_type, key_id text,
  wrapped_key bytea
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
  d public.document;
BEGIN
  IF p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  SELECT * INTO l FROM public.export_link e
  WHERE e.token_hash = p_link_hash AND e.session_hash = p_session_hash
    AND e.staff_user_id = (p_context).staff_user_id AND e.expires_at > now()
    AND (p_context).on_behalf_of IS NULL
    AND EXISTS (
      SELECT FROM public.staff_session s
      JOIN public.staff_user u ON u.id = s.staff_user_id
      WHERE s.token_hash = p_session_hash AND s.staff_user_id = e.staff_user_id
        AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  FOR d IN SELECT x.* FROM public.document x WHERE x.id = ANY (l.document_ids) LOOP
    IF NOT public.export_document_allowed(d, l.staff_user_id) THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM public.document x WHERE x.id = ANY (l.document_ids))
     <> pg_catalog.cardinality(l.document_ids) THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', pg_catalog.cardinality(l.document_ids)), false);
  RETURN QUERY
    SELECT x.id, x.participation_id, x.type, x.key_id, x.wrapped_key
    FROM pg_catalog.unnest(l.document_ids) WITH ORDINALITY AS u(id, ord)
    JOIN public.document x ON x.id = u.id
    ORDER BY u.ord;
END $$;
--> statement-breakpoint

-- Replaced: the Kug 200b and export events are written only by their functions too.
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
      'declaration_withdrawal_ba_notified', 'export_created', 'export_downloaded') THEN
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

-- Grants: transfer_app selects the offer's tables and the consent record's new columns (no
-- ciphertext) and writes nothing; it has no privilege on the export links; it executes the
-- recreated document functions, the generation, the bulk lock, the purpose-bound read, the offer's
-- functions and the export's two.
GRANT SELECT ON TABLE kug200b_decline, kug200b_withdrawal TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON TABLE export_link FROM transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION current_document_policy, scan_form, add_document,
  record_document_upload_rejected, document_link_content, lock_kug200b_actor,
  form_checklist_valid, record_form_generation, lock_bulk_form_generation, read_kug200b_values,
  decline_kug200b_offer, record_declaration_withdrawal, record_withdrawal_ba_notice,
  export_document_visible, export_document_allowed, create_export_link, export_link_content
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_document, record_document_upload_rejected, document_link_content,
  record_form_generation, lock_bulk_form_generation, read_kug200b_values, decline_kug200b_offer,
  record_declaration_withdrawal, record_withdrawal_ba_notice, create_export_link,
  export_link_content TO transfer_app;
