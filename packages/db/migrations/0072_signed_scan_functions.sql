-- Hand-written (ADR-0002, signed scans; data-protection.md, signed scans, signed declarations and
-- quarantine; process-and-lifecycle.md, profiling track; Q183–Q185, Q191, Q193): the document
-- type catalog's version 4 with the signed TL 407's operations, the scan's origin at the upload,
-- the review with the actual signature dates, the confirmations and the signed declarations, the
-- PL's deletion before review, quarantine and its lift, the opening's refusal of a quarantined
-- document, the reader of the TL 407 facts, `profiling_done` holding its accepted scan, the
-- history's projection rows and the grants. Same hardening as 0070: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. Audit details carry ids, codes and versions only, never a declaration's value. The event
-- types 0071 added are compared as text here, since this runs after it in the same migration run.
--
-- Lock order (ADR-0002): the project's advisory lock shared through `lock_participation`, the
-- participation row, then its documents in id order (`FOR SHARE` the generation a scan names,
-- `FOR UPDATE` the one changed); `profiling_done` holds the participation, then its accepted TL 407
-- scan `FOR SHARE`.

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
    'document_quarantine_lifted', 'signed_declaration_recorded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a review names a scan's origin
-- and version; a quarantine its reason; the signed declarations their codes.
UPDATE audit_event_projection SET detail_keys = '{documentType,decision,origin,formVersion}'
WHERE event_type = 'document_reviewed';
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('document_quarantined', NULL, 'case', false, true, '{documentType}'),
  ('document_quarantine_lifted', NULL, 'case', false, false, '{documentType}'),
  ('signed_declaration_recorded', NULL, 'profiling', false, false,
    '{formCode,formVersion,declarations}');
--> statement-breakpoint

-- Catalog version 4 (packages/domain/src/documents/catalog.ts): version 3's rows, the signed TL 407
-- with its operations (Q184): added and reviewed by the assigned consultant and the PL, deleted
-- by the PL before its review. Documents of earlier versions keep their rows.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles)
SELECT type, 4, retention_class, file_name, signed, generated,
  CASE WHEN type = 'tl407_signed_scan' THEN '{consultant,project_lead}' ELSE add_roles END,
  CASE WHEN type = 'tl407_signed_scan' THEN '{consultant,project_lead}' ELSE review_roles END,
  CASE WHEN type = 'tl407_signed_scan' THEN '{project_lead}' ELSE delete_roles END,
  open_roles
FROM document_type_policy WHERE catalog_version = 3;
--> statement-breakpoint

-- Internal helpers (no grant).

-- The form a signed scan type is of (the domain's `scanForms`); null for any other type.
CREATE FUNCTION scan_form(p_type document_type)
RETURNS form_code LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_type WHEN 'tl407_signed_scan' THEN 'tl407'::public.form_code END
$$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- An upload stored (data-protection.md, uploads; Q143, Q146), as 0070 wrote it, and a signed scan's
-- origin (data-protection.md, signed scans; Q184): a scan type names one (`invalid_argument`
-- without, or with one for another type); a signed type is added in normal mode only
-- (`actor_not_allowed` in assisted mode); `generated` names a generation of the same
-- participation and form (`generation_not_found`), held `FOR SHARE`, whose form code and version
-- the scan takes; external paper gets its version at acceptance.
DROP FUNCTION "public"."add_document"("public"."audit_context", uuid, uuid, "public"."document_type", "public"."document_media_type", integer, text, text, text, bytea, text);
--> statement-breakpoint
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

-- The TL 407's declarations as given to `review_document`: `{kind: 'as_printed'}`, or
-- `{kind: 'as_marked', jobboerseChoice, baContactConsent}`, each null or a value of its kind.
CREATE FUNCTION scan_declarations_valid(p_declarations jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_declarations) = 'object' AND CASE
    p_declarations ->> 'kind'
    WHEN 'as_printed' THEN
      ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k) = '{kind}'::text[]
    WHEN 'as_marked' THEN
      ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k ORDER BY k)
        = '{baContactConsent,jobboerseChoice,kind}'::text[]
      AND public.form_declarations_valid(p_declarations - 'kind')
    ELSE false END, false)
$$;
--> statement-breakpoint

-- A review (process-and-lifecycle.md, document review; Q146), as 0054 wrote it, and a signed
-- scan's (data-protection.md, signed scans and signed declarations; Q184, Q185, Q193): not while
-- quarantined (`document_quarantined`), not after the participation's end
-- (`participation_closed`). An acceptance records the participant's (`p_signed_on`) and the
-- profiler's (`p_countersigned_on`) actual signature dates, not after today in Berlin
-- (`signature_in_future`) and for a generated scan not before its generation's Berlin date
-- (`signature_before_generation`); both confirmations; for external paper the version named
-- (a generated scan has its generation's); and the declarations: as printed (the generation's
-- snapshot, a generated scan only) or as marked. They become immutable `signed_declaration`
-- rows, audited `signed_declaration_recorded` (codes only); an earlier signed form's rows stay.
-- A rejection records nothing of the paper. `document_reviewed` names a scan's origin and its
-- accepted version. Any other type takes none of this (`invalid_argument`).
DROP FUNCTION "public"."review_document"("public"."audit_context", uuid, "public"."document_review_state", "public"."document_review_reason");
--> statement-breakpoint
CREATE FUNCTION review_document(
  p_context audit_context, p_document_id uuid, p_decision document_review_state,
  p_reason document_review_reason, p_signed_on date DEFAULT NULL,
  p_countersigned_on date DEFAULT NULL, p_confirmations text[] DEFAULT NULL,
  p_form_version text DEFAULT NULL, p_declarations jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  g public.form_generation;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_generation_id uuid;
  v_roles text[];
  v_id uuid;
  v_accept boolean := p_decision = 'accepted';
  v_paper boolean := p_signed_on IS NOT NULL OR p_countersigned_on IS NOT NULL
    OR p_confirmations IS NOT NULL OR p_form_version IS NOT NULL OR p_declarations IS NOT NULL;
  v_version text;
  v_choice text;
  v_contact text;
  v_signed_on date;
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
       OR v_accept AND (p_signed_on IS NULL OR p_countersigned_on IS NULL
         OR p_confirmations IS NULL
         OR NOT p_confirmations @> '{signatures_present,all_pages_present}'::text[]
         OR NOT p_confirmations <@ '{signatures_present,all_pages_present}'::text[]
         OR NOT public.scan_declarations_valid(p_declarations)
         OR (d.scan_origin = 'external_paper') <> (p_form_version IS NOT NULL)
         OR p_form_version !~ '^(0[1-9]|1[0-2])-[0-9]{4}$'
         OR d.scan_origin = 'external_paper' AND p_declarations ->> 'kind' = 'as_printed') THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END IF;
  IF v_accept AND d.scan_origin IS NOT NULL THEN
    IF greatest(p_signed_on, p_countersigned_on) > public.berlin_today() THEN
      RAISE EXCEPTION 'signature_in_future';
    END IF;
    IF d.scan_origin = 'generated' THEN
      SELECT * INTO g FROM public.form_generation WHERE document_id = d.generation_document_id;
      IF least(p_signed_on, p_countersigned_on)
         < (g.generated_at AT TIME ZONE 'Europe/Berlin')::date THEN
        RAISE EXCEPTION 'signature_before_generation';
      END IF;
    END IF;
    v_version := coalesce(d.form_version, p_form_version);
    v_signed_on := greatest(p_signed_on, p_countersigned_on);
    IF p_declarations ->> 'kind' = 'as_printed' THEN
      v_choice := g.jobboerse_choice::text;
      v_contact := CASE g.ba_contact_consent WHEN true THEN 'yes' WHEN false THEN 'no' END;
    ELSE
      v_choice := p_declarations ->> 'jobboerseChoice';
      v_contact := CASE (p_declarations ->> 'baContactConsent')::boolean
        WHEN true THEN 'yes' WHEN false THEN 'no' END;
    END IF;
    UPDATE public.document SET review_state = 'accepted', reviewed_by = (p_context).staff_user_id,
      reviewed_at = now(), form_code = public.scan_form(d.type), form_version = v_version,
      signed_on = p_signed_on, countersigned_on = p_countersigned_on,
      review_confirmations = '{signatures_present,all_pages_present}'
    WHERE id = d.id;
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
        'formVersion', v_version, 'declarations', '["jobboerseChoice","baContactConsent"]'::jsonb),
      false);
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

-- A deletion (Q146), as 0070 wrote it, and a signed scan's (data-protection.md, signed scans;
-- Q183): by the policy's delete roles (the PL) before its review only, as `wrong_person` or
-- `wrong_file` (`delete_reason_not_allowed`); reviewed, or a signed type whose operations are
-- undecided, it is `document_immutable`, as a generated form always is. The tombstone keeps the
-- scan's origin and generation; the API queues the object's purge in the same transaction.
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
  IF pol.generated OR pol.signed
     AND (pg_catalog.cardinality(pol.delete_roles) = 0 OR d.review_state <> 'unreviewed') THEN
    RAISE EXCEPTION 'document_immutable';
  END IF;
  IF NOT v_roles && pol.delete_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF pol.signed AND p_reason NOT IN ('wrong_person', 'wrong_file') THEN
    RAISE EXCEPTION 'delete_reason_not_allowed';
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

-- Quarantine at once (data-protection.md, quarantine; Q183): staff in normal mode by the
-- policy's review roles (the PL, the assigned consultant), whatever the review state and also
-- after the participation's end, with a closed reason; once (`document_quarantined`). While
-- quarantined a document opens for nobody, isn't reviewed, gives no fact and counts nothing.
-- Audited `document_quarantined` (the reason as its reason code).
CREATE FUNCTION quarantine_document(
  p_context audit_context, p_document_id uuid, p_reason document_quarantine_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT review_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  UPDATE public.document SET quarantine_reason = p_reason,
    quarantined_by = (p_context).staff_user_id, quarantined_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_quarantined',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- The lift (data-protection.md, quarantine): whoever quarantined it, while they may still, or
-- the PL; only a quarantined document (`document_not_quarantined`). Corrections (a pending one
-- would refuse the lift) come with their own slice. Keeps the lift's instant, from which a fact
-- counts as recorded again. Audited `document_quarantine_lifted`.
CREATE FUNCTION lift_document_quarantine(p_context audit_context, p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
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
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT review_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version)
     OR d.quarantined_by IS DISTINCT FROM (p_context).staff_user_id
       AND NOT 'project_lead' = ANY (v_roles) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NULL THEN
    RAISE EXCEPTION 'document_not_quarantined';
  END IF;
  UPDATE public.document SET quarantine_reason = NULL, quarantined_by = NULL,
    quarantined_at = NULL, quarantine_lifted_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id,
    'document_quarantine_lifted', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- The opening (Q147), as 0054 wrote it; a quarantined document opens for nobody
-- (`document_quarantined`; break-glass comes with its slice).
CREATE OR REPLACE FUNCTION open_document(
  p_context audit_context, p_document_id uuid, p_session_kind document_session_kind,
  p_session_hash text, p_link_hash text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_roles text[];
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_document_id IS NULL OR p_session_kind IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO d FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, d.participation_id, '{participant,user}');
  IF ((p_context).actor_type = 'participant') <> (p_session_kind = 'participant') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL THEN
    PERFORM FROM public.staff_session s
    JOIN public.staff_user u ON u.id = s.staff_user_id
    WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
      AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
  END IF;
  v_roles := public.lock_document_actor(d.participation_id, p_context, p_session_hash, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.open_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  INSERT INTO public.document_link (token_hash, document_id, project_id, participation_id,
    session_kind, session_hash, expires_at)
  VALUES (p_link_hash, d.id, d.project_id, d.participation_id, p_session_kind, p_session_hash,
    v_expires);
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_opened', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentType', d.type, 'documentId', d.id), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- A link's content (Q147), as 0070 wrote it; never a quarantined document's, also within the
-- 60 s of a link opened before the quarantine.
CREATE OR REPLACE FUNCTION document_link_content(
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

-- The accepted TL 407 scans a fact may rest on (process-and-lifecycle.md, guards; data-protection.md,
-- quarantine): live, not quarantined, not invalidated; each valid on its later signature date and
-- recorded at its acceptance or, after a quarantine, at its last lift.
CREATE FUNCTION tl407_evidence(p_participation_id uuid)
RETURNS TABLE (document_id uuid, valid_on date, recorded_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT d.id, greatest(d.signed_on, d.countersigned_on),
    greatest(d.reviewed_at, coalesce(d.quarantine_lifted_at, d.reviewed_at))
  FROM public.document d
  WHERE d.participation_id = p_participation_id AND d.type = 'tl407_signed_scan'
    AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
    AND d.invalidated_by_correction IS NULL
$$;
--> statement-breakpoint

-- The dated TL 407 facts of the guards (process-and-lifecycle.md, guards and the snapshot rule;
-- the status service's provider reads them inside its transaction, after the participation's
-- lock; the work list for all its participations at once), from the usable scans (accepted, live,
-- not quarantined, not invalidated) only. Per participation with such a scan: `tl407Signed`,
-- valid on the earliest later signature date, recorded when that scan was. `profilingDone` only
-- while the profiling track is `profiling_done` and a usable scan signed by `profiling_done_on`
-- supports that date: valid on `profiling_done_on`, recorded at the later of the status change and
-- the earliest such scan; without one it is withheld (null), the status and its date stay as
-- recorded for a controlled resolution and are never moved. No row without a usable scan. Dates
-- and instants only.
CREATE FUNCTION tl407_facts(p_participation_ids uuid[])
RETURNS TABLE (
  participation_id uuid, tl407_signed_on date, tl407_recorded_at timestamptz,
  profiling_done_on date, profiling_done_recorded_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH evidence AS (
    SELECT d.participation_id, greatest(d.signed_on, d.countersigned_on) AS valid_on,
      greatest(d.reviewed_at, coalesce(d.quarantine_lifted_at, d.reviewed_at)) AS recorded_at
    FROM public.document d
    WHERE d.participation_id = ANY (p_participation_ids) AND d.type = 'tl407_signed_scan'
      AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
      AND d.invalidated_by_correction IS NULL
  ), scan AS (
    SELECT DISTINCT ON (e.participation_id) e.participation_id, e.valid_on, e.recorded_at
    FROM evidence e
    ORDER BY e.participation_id, e.valid_on, e.recorded_at
  ), support AS (
    -- The scans that support the recorded completion date: signed by it.
    SELECT e.participation_id, pg_catalog.min(e.recorded_at) AS recorded_at
    FROM evidence e
    JOIN public.participation p ON p.id = e.participation_id
    WHERE e.valid_on <= p.profiling_done_on
    GROUP BY e.participation_id
  )
  SELECT s.participation_id, s.valid_on, s.recorded_at,
    CASE WHEN u.recorded_at IS NOT NULL THEN p.profiling_done_on END,
    CASE WHEN u.recorded_at IS NOT NULL THEN greatest(u.recorded_at, (
      SELECT pg_catalog.max(a.occurred_at) FROM public.audit_event a
      WHERE a.participation_id = p.id AND a.event_type = 'status_changed'
        AND a.field = 'profiling_status' AND a.to_value = 'profiling_done')) END
  FROM scan s
  JOIN public.participation p ON p.id = s.participation_id
  LEFT JOIN support u ON u.participation_id = s.participation_id
$$;
--> statement-breakpoint

-- The status body (0042), and `profiling_done` (process-and-lifecycle.md, profiling track; Q191):
-- it holds the participation's accepted TL 407 scan `FOR SHARE` (a live, unquarantined,
-- uninvalidated one), and its date is not before that scan's later signature date
-- (`effective_date_before_signature`). The guard `tl407_signed` itself is the status service's,
-- as every guard is (its dated facts, which the seed overlays). Everything else unchanged.
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
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system,participant}');
  IF p_field IS NULL OR p_to IS NULL OR p_activation IS NULL
     OR p_activation AND p_entry_kind IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (D9, R1, Q98): no transition of a draft project, manual or system. The shared
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

  -- Track activity (plan 5.3): the tracks move while `informed` (DSV only in ta_tg); in the TG
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

  -- Round 18: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (round 9), only they.
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
      'offerDeadline', p_offer_deadline)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies (round 10; system-only, round 12), as
  -- system with the same correlation ids (round 16).
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
  RETURN v_event;
END $$;
--> statement-breakpoint

-- Replaced: the signed-paper events are written only by their functions too.
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
      'document_quarantine_lifted', 'signed_declaration_recorded') THEN
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

-- Grants: transfer_app selects the signed declarations and the scan's new metadata (no
-- ciphertext) and writes nothing; it executes the changed document functions, quarantine, its lift and the facts' reader.
GRANT SELECT ON TABLE signed_declaration TO transfer_app;
--> statement-breakpoint
GRANT SELECT (scan_origin, generation_document_id, form_code, form_version, signed_on,
  countersigned_on, review_confirmations, quarantine_reason, quarantined_by, quarantined_at,
  quarantine_lifted_at, invalidated_by_correction) ON TABLE document TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION scan_form, add_document, scan_declarations_valid, review_document,
  quarantine_document, lift_document_quarantine, tl407_evidence, tl407_facts FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_document, review_document, quarantine_document,
  lift_document_quarantine, tl407_facts TO transfer_app;
