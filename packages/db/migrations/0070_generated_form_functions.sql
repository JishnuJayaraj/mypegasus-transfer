-- Hand-written (ADR-0002, generated forms; data-protection.md, generated forms and the readiness
-- projection; Q179): the document type catalog's version 3 with the generated TL 407, the four
-- document functions 0069 dropped with the recreated `document_type` (unchanged), the generation's
-- record, the deletion's refusal of a generated form, the history's projection row and the
-- grants. Same hardening as 0068: SECURITY DEFINER owned by transfer_owner, a fixed search_path
-- with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app,
-- database time, refusals as P0001 with a stable code, never a value. Audit details carry ids,
-- codes and versions only: never a value of the form. The event type 0069 added is compared as
-- text here, since this runs after it in the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock shared through `lock_participation`, the
-- participation row, then the new document and its generation; the source rows whose revisions
-- are compared are written only under the same participation lock, which this holds.

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
    'profiling_declarations_recorded', 'form_generated'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a generated form in the
-- `case` stream by its code, version, document and Anlage.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('form_generated', NULL, 'case', false, false, '{formCode,formVersion,documentId,anlage}');
--> statement-breakpoint

-- Catalog version 3 (packages/domain/src/documents/catalog.ts): version 2's rows and the generated
-- TL 407 (`tl407_form`): the signed type's open roles, the working copy's class, no add, review or
-- delete role (`generated`). Documents of version 2 keep their rows.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles)
SELECT type, 3, retention_class, file_name, signed, false, add_roles, review_roles, delete_roles,
  open_roles
FROM document_type_policy WHERE catalog_version = 2;
--> statement-breakpoint
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles) VALUES
  ('tl407_form', 3, 'form_working_copy', false, false, true, '{}', '{}', '{}',
    '{consultant,project_lead}');
--> statement-breakpoint

-- Created again with the recreated type, as 0054 wrote them.

-- The policy a new document of the type gets: the type's row of the latest catalog version.
CREATE FUNCTION current_document_policy(p_type document_type)
RETURNS document_type_policy LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM public.document_type_policy WHERE type = p_type
  ORDER BY catalog_version DESC LIMIT 1
$$;
--> statement-breakpoint
-- An upload stored (data-protection.md, uploads; Q143, Q146): the API detected the type, scanned,
-- encrypted and stored the object first, and deletes it on any refusal here. Under the
-- participation lock: `participation_closed`, `document_type_not_supported` (operations
-- undecided, Q65), `actor_not_allowed` (not an add role of the type, or a file name for a type
-- that keeps none: `invalid_argument`), `document_limit` (50 live documents) and
-- `upload_rate_limited` (20 added within the hour, by anyone; documentLimits). Audited
-- `document_added` (id, type, source `portal` / `staff` / `assisted`). Returns the id.
CREATE FUNCTION add_document(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_type document_type,
  p_media_type document_media_type, p_size_bytes integer, p_content_sha256 text,
  p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pol public.document_type_policy := public.current_document_policy(p_type);
  v_roles text[];
  v_project_id uuid;
BEGIN
  IF p_id IS NULL OR p_type IS NULL OR p_media_type IS NULL OR p_size_bytes IS NULL
     OR p_size_bytes NOT BETWEEN 1 AND 10485760
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR p_wrapped_key IS NULL OR pg_catalog.octet_length(p_wrapped_key) <> 60
     OR p_file_name IS NOT NULL AND (pg_catalog.char_length(p_file_name) NOT BETWEEN 1 AND 200
       OR p_file_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(p_participation_id, p_context, p_token_hash, true);
  IF pg_catalog.cardinality(pol.add_roles) = 0 THEN
    RAISE EXCEPTION 'document_type_not_supported';
  END IF;
  IF NOT v_roles && pol.add_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p_file_name IS NOT NULL AND NOT pol.file_name THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE participation_id = p_participation_id AND deleted_at IS NULL) >= 50 THEN
    RAISE EXCEPTION 'document_limit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE participation_id = p_participation_id AND added_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'upload_rate_limited';
  END IF;
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf)
  VALUES (p_id, v_project_id, p_participation_id, p_type, pol.catalog_version,
    pol.retention_class, p_media_type, p_size_bytes, p_content_sha256, p_file_name, p_key_id,
    p_wrapped_key, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).on_behalf_of IS NOT NULL);
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'document_added', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_id,
      'documentType', p_type, 'source', CASE
        WHEN (p_context).actor_type = 'participant' THEN 'portal'
        WHEN (p_context).on_behalf_of IS NOT NULL THEN 'assisted'
        ELSE 'staff' END), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- An upload the scan refused (Q144): nothing was stored; only the audit event
-- `document_upload_rejected` with the type and the code (`file_infected`, `file_unscannable`),
-- after the same actor checks as `add_document`.
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

-- What the content route needs to answer a link (Q147): only a live link (not expired) of this
-- session kind and hash, the session still live (a participant's active one; a staff one not
-- ended or expired, of an active account), and a live document. Not audited again: the opening
-- was. The only path that returns the wrapped key.
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

-- The source revisions a generation was built from (the API's read): `{profile, profiling,
-- assessment, unemployment}`, each a revision ≥ 0 (0 before the first write).
CREATE FUNCTION form_sources_valid(p_sources jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_sources) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_sources) k ORDER BY k)
      = '{assessment,profile,profiling,unemployment}'::text[]
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_each(p_sources) e(k, v)
      WHERE pg_catalog.jsonb_typeof(v) <> 'number' OR v::text !~ '^[0-9]{1,9}$'), false)
$$;
--> statement-breakpoint

-- The declarations to the BA a generation printed (ba-forms.md, declarations to the BA):
-- `{jobboerseChoice, baContactConsent}`, each null or a value of its kind.
CREATE FUNCTION form_declarations_valid(p_declarations jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_declarations) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k ORDER BY k)
      = '{baContactConsent,jobboerseChoice}'::text[]
    AND (p_declarations -> 'jobboerseChoice' = 'null'::jsonb
      OR p_declarations ->> 'jobboerseChoice'
        = ANY (pg_catalog.enum_range(NULL::public.jobboerse_choice)::text[]))
    AND pg_catalog.jsonb_typeof(p_declarations -> 'baContactConsent') IN ('null', 'boolean'),
    false)
$$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A generated form stored (data-protection.md, generated forms; Q179): the API read its sources
-- in one snapshot (each decryption audited), checked, laid out and rendered the form, encrypted
-- and stored the file first, and deletes it on any refusal here. Only the TL 407 so far
-- (`form_not_supported`). Under the participation lock (`lock_profiler`: the assigned consultant
-- as themselves, `participation_closed`): `source_changed` when a source revision moved since the
-- read or the printed declarations aren't the pending ones. Inserts the document (`tl407_form`,
-- the catalog's current policy) and its generation: the provenance (form code and version, the
-- source revisions), the declaration snapshot, the confirmed warning codes and the Anlage.
-- Audited `form_generated` (document, code, version, Anlage) and one `warning_confirmed` per
-- confirmed code. Returns the generation's id.
CREATE FUNCTION record_form_generation(
  p_context audit_context, p_participation_id uuid, p_generation_id uuid, p_document_id uuid,
  p_form_code form_code, p_form_version text, p_sources jsonb, p_declarations jsonb,
  p_confirmed_warnings text[], p_anlage boolean, p_size_bytes integer, p_content_sha256 text,
  p_key_id text, p_wrapped_key bytea
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pol public.document_type_policy := public.current_document_policy('tl407_form');
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
     OR NOT public.form_declarations_valid(p_declarations)
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
  IF p_form_code <> 'tl407' THEN
    RAISE EXCEPTION 'form_not_supported';
  END IF;
  r := public.lock_profiler(p_participation_id, p_context);
  SELECT revision INTO v_profile FROM public.participant_profile WHERE participation_id = r.id;
  SELECT * INTO pr FROM public.participant_profiling WHERE participation_id = r.id;
  SELECT revision INTO v_assessment FROM public.participant_profiling_assessment
  WHERE participation_id = r.id;
  SELECT unemployment_revision INTO v_unemployment FROM public.participant_residence_social_data
  WHERE participation_id = r.id;
  IF coalesce(v_profile, 0) <> (p_sources ->> 'profile')::integer
     OR coalesce(pr.revision, 0) <> (p_sources ->> 'profiling')::integer
     OR coalesce(v_assessment, 0) <> (p_sources ->> 'assessment')::integer
     OR coalesce(v_unemployment, 0) <> (p_sources ->> 'unemployment')::integer
     OR pr.jobboerse_choice::text IS DISTINCT FROM p_declarations ->> 'jobboerseChoice'
     OR pr.ba_contact_consent IS DISTINCT FROM (p_declarations ->> 'baContactConsent')::boolean THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf)
  VALUES (p_document_id, r.project_id, r.id, 'tl407_form', pol.catalog_version,
    pol.retention_class, 'application/pdf', p_size_bytes, p_content_sha256, NULL, p_key_id,
    p_wrapped_key, 'user', (p_context).staff_user_id, false);
  INSERT INTO public.form_generation (id, project_id, participation_id, document_id, form_code,
    form_version, profile_revision, profiling_revision, assessment_revision,
    unemployment_revision, jobboerse_choice, ba_contact_consent, confirmed_warnings, anlage,
    generated_by)
  VALUES (p_generation_id, r.project_id, r.id, p_document_id, p_form_code, p_form_version,
    (p_sources ->> 'profile')::integer, (p_sources ->> 'profiling')::integer,
    (p_sources ->> 'assessment')::integer, (p_sources ->> 'unemployment')::integer,
    pr.jobboerse_choice, pr.ba_contact_consent, p_confirmed_warnings, p_anlage,
    (p_context).staff_user_id);
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

-- A deletion (Q146): staff in normal mode by the policy's delete roles, with a reason code; the
-- participant their own (`actor_not_allowed` for one staff added) while not accepted
-- (`document_accepted`), without one. Signed and generated types never (`document_immutable`;
-- the retention job only). The row stays as a tombstone, its file name erased; the API queues the object's purge in
-- the same transaction. Audited `document_deleted` (the reason as its reason code).
CREATE OR REPLACE FUNCTION delete_document(
  p_context audit_context, p_document_id uuid, p_reason document_delete_reason,
  p_token_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{participant,user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF ((p_context).actor_type = 'user') <> (p_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, p_token_hash, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF pol.signed OR pol.generated THEN
    RAISE EXCEPTION 'document_immutable';
  END IF;
  IF NOT v_roles && pol.delete_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF d.added_by <> 'participant' THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    IF d.review_state = 'accepted' THEN
      RAISE EXCEPTION 'document_accepted';
    END IF;
  END IF;
  UPDATE public.document SET deleted_at = now(), deleted_by = (p_context).actor_type,
    deleted_by_staff_user_id = (p_context).staff_user_id, delete_reason = p_reason,
    file_name = NULL
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_deleted',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- Replaced: a generated form's event is written only by its function too.
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
      'profiling_declarations_recorded', 'form_generated') THEN
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

-- Grants: transfer_app selects the generations (no ciphertext: the file is the document's) and
-- writes nothing; it executes the recreated document functions and the generation's record.
GRANT SELECT ON TABLE form_generation TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION current_document_policy, add_document, record_document_upload_rejected,
  document_link_content, form_sources_valid, form_declarations_valid, record_form_generation
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_document, record_document_upload_rejected, document_link_content,
  record_form_generation TO transfer_app;
