-- Hand-written (ADR-0002, generated forms and project setup; process-and-lifecycle.md, the DSV:
-- generation; data-protection.md, generated forms; Slice 7 D1–D3): the document functions 0089
-- dropped with the recreated `document_type`, created again unchanged; document catalog version 8
-- with the generated DSV; the DSV's source token and currency; the generation of the DSV with its
-- deadline and token; the project's DSV template pin; the history's projection rows and the
-- grants. Same hardening as 0088: SECURITY DEFINER owned by transfer_owner, a fixed search_path
-- with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app,
-- database time, refusals as P0001 with a stable code, never a value. The values 0089 added to
-- `form_code` and `audit_event_type` are compared as text here, since this runs after it in the
-- same migration run.
--
-- Lock order (ADR-0002; Slice 7 D26): a generation takes the project's shared advisory lock and
-- the participation row (`lock_participation`); the pin takes the project's exclusive lock
-- (`lock_project_setup`) first.

-- Created again with the recreated type, as 0076 (and 0078 for `export_link_content`) wrote them.
-- The policy a new document of the type gets: the type's row of the latest catalog version.
CREATE FUNCTION public.current_document_policy(p_type document_type)
 RETURNS document_type_policy
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT * FROM public.document_type_policy WHERE type = p_type
  ORDER BY catalog_version DESC LIMIT 1
$function$
--> statement-breakpoint

-- The form a signed scan type is of (the domain's `scanForms`); null for any other type.
CREATE FUNCTION public.scan_form(p_type document_type)
 RETURNS form_code
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE p_type::text
    WHEN 'tl407_signed_scan' THEN 'tl407'::public.form_code
    WHEN 'kug200b_signed_scan' THEN 'kug200b'::public.form_code END
$function$
--> statement-breakpoint

-- An upload stored (data-protection.md, uploads and signed scans), as 0076 wrote it.
CREATE FUNCTION public.add_document(p_context audit_context, p_participation_id uuid, p_id uuid, p_type document_type, p_media_type document_media_type, p_size_bytes integer, p_content_sha256 text, p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL::text, p_scan_origin scan_origin DEFAULT NULL::scan_origin, p_generation_document_id uuid DEFAULT NULL::uuid)
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
END $function$
--> statement-breakpoint

-- A refused upload audited (data-protection.md, uploads), as 0076 wrote it.
CREATE FUNCTION public.record_document_upload_rejected(p_context audit_context, p_participation_id uuid, p_type document_type, p_code text, p_token_hash text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$
--> statement-breakpoint

-- A document link's content (data-protection.md, documents), as 0076 wrote it.
CREATE FUNCTION public.document_link_content(p_link_hash text, p_session_kind document_session_kind, p_session_hash text)
 RETURNS TABLE(document_id uuid, participation_id uuid, document_type document_type, media_type document_media_type, file_name text, key_id text, wrapped_key bytea, added_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT d.id, d.participation_id, d.type, d.media_type, d.file_name, d.key_id, d.wrapped_key,
    d.added_at
  FROM public.document_link l
  JOIN public.document d ON d.id = l.document_id
  WHERE l.token_hash = p_link_hash AND l.session_kind = p_session_kind
    AND l.session_hash = p_session_hash AND l.expires_at > now() AND d.deleted_at IS NULL
    AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
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
$function$
--> statement-breakpoint

-- An export link's content (data-protection.md, exports), as 0076 wrote it.
CREATE FUNCTION public.export_link_content(p_context audit_context, p_link_hash text, p_session_hash text)
 RETURNS TABLE(document_id uuid, participation_id uuid, document_type document_type, key_id text, wrapped_key bytea)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.kind::text <> 'kug200b_print' THEN
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
END $function$
--> statement-breakpoint

-- The audit types this migration run added are compared as text (they can't be used yet).
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
    'evidence_correction_requested', 'evidence_correction_decided', 'dsv_form_generated'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): the DSV's generation in the
-- `dsv` stream by its template version and deadline kind; the pin is project-level.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('dsv_form_generated', NULL, 'dsv', false, false, '{templateVersion,deadlineKind}'),
  ('dsv_template_pinned', NULL, NULL, false, false, '{}');
--> statement-breakpoint

-- Document catalog version 8 (data-protection.md, documents and generated forms; Slice 7 D2): the
-- generated DSV, a working copy the PL and back office open through the logged opening; written
-- only by `record_form_generation`. Every other type as in version 7.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles)
SELECT type, 8, retention_class, file_name, signed, generated, add_roles, review_roles,
  delete_roles, open_roles, quarantine_roles
FROM document_type_policy WHERE catalog_version = 7;
--> statement-breakpoint
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles) VALUES
  ('dsv_form', 8, 'form_working_copy', false, false, true, '{}', '{}', '{}',
    '{back_office,project_lead}', '{}');
--> statement-breakpoint

-- Internal helpers (no grant).

-- The DSV's source token (Slice 7 D2; the domain's `dsvSourceCanonical`, a test holds them equal):
-- the SHA-256, as lowercase hex, of the line `dsv-sources:v1` and one line per printed source in a
-- fixed order, `key=` and the value as a JSON string or `null`, joined by line feeds, as UTF-8. The
-- person and the effective dates as `form_person` reads them, the participation's wave, the
-- project's pinned template and customer, and the Transfergesellschaft's fingerprint the caller
-- passes (its version is the deployment's file). Null for an unknown participation.
CREATE FUNCTION dsv_source_token(p_participation_id uuid, p_organisation_sha256 text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.array_to_string(
    ARRAY['dsv-sources:v1'] || ARRAY(
      SELECT v.key || '=' || coalesce(pg_catalog.to_jsonb(v.value)::text, 'null')
      FROM (VALUES
        (1, 'templateVersion', pj.dsv_template_version),
        (2, 'firstName', fp ->> 'firstName'),
        (3, 'lastName', fp ->> 'lastName'),
        (4, 'birthDate', fp ->> 'birthDate'),
        (5, 'street', fp ->> 'street'),
        (6, 'postalCode', fp ->> 'postalCode'),
        (7, 'city', fp ->> 'city'),
        (8, 'country', fp ->> 'country'),
        (9, 'tgStart', fp ->> 'tgStart'),
        (10, 'tgEnd', fp ->> 'tgEnd'),
        (11, 'entryWaveId', p.entry_wave_id::text),
        (12, 'customerName', pj.customer_name),
        (13, 'organisationSha256', p_organisation_sha256)) v(n, key, value)
      ORDER BY v.n),
    E'\n'), 'UTF8')), 'hex')
  FROM public.participation p
  JOIN public.project pj ON pj.id = p.project_id
  CROSS JOIN LATERAL public.form_person(p.id) fp
  WHERE p.id = p_participation_id
$$;
--> statement-breakpoint

-- Whether a DSV generation can still be handed out (Slice 7 D3): its token equal to the current
-- one (with the Transfergesellschaft's current fingerprint), its deadline not passed in Berlin, and
-- for the wave's deadline that deadline still the wave's. False for any other generation. The
-- offers (7-2a) add "no later offer ended after it".
CREATE FUNCTION dsv_generation_current(p_generation_id uuid, p_organisation_sha256 text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((
    SELECT g.source_token = public.dsv_source_token(g.participation_id, p_organisation_sha256)
      AND g.offer_deadline >= (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date
      AND (g.deadline_kind::text <> 'wave' OR g.offer_deadline IS NOT DISTINCT FROM (
        SELECT w.signing_deadline FROM public.participation p
        JOIN public.project_entry_wave w ON w.id = p.entry_wave_id
        WHERE p.id = g.participation_id))
    FROM public.form_generation g
    WHERE g.id = p_generation_id AND g.form_code::text = 'dsv'), false)
$$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A generated form stored (data-protection.md, generated forms; Q179), as 0076 wrote it for the
-- TL 407 and the Kug 200b, and the DSV's (process-and-lifecycle.md, the DSV: generation; Slice 7
-- D1–D3): the PL or back office of the project as themselves (`actor_not_allowed`), the
-- participation locked (the shared project lock first, so a pin, which takes the exclusive one,
-- waits); an active `ta_tg` project, an open participation in a wave with both effective TG dates,
-- the DSV track `not_offered`, `dsv_declined` or `dsv_expired` (`dsv_offer_open` for an open offer,
-- whose paper is reopened; `dsv_not_generatable` otherwise) and the project's pinned template as
-- `p_form_version` (`dsv_not_generatable` while none is pinned, `source_changed` for another). The
-- deadline (`p_offer_deadline`, `p_deadline_kind`): the wave's signing deadline only for a first
-- offer and only as the wave has it now (`source_changed`), else explicit; today in Berlin ≤
-- deadline ≤ the wave's latest entry date and ≤ the effective TG start (`offer_deadline_invalid`,
-- failing closed when either is missing). Its printed sources compared under the lock: the person
-- (`form_person`, `p_person`) and the source token (`dsv_source_token` with `p_organisation_sha256`)
-- (`source_changed`). A DSV keeps its handwriting checklist, takes no declaration, warning, Anlage
-- or employer fingerprint (`invalid_argument`). Audited `dsv_form_generated` (document, template
-- version, deadline kind), never `form_generated`. Returns the generation's id.
DROP FUNCTION "public"."record_form_generation"("public"."audit_context", uuid, uuid, uuid, "public"."form_code", text, jsonb, jsonb, text, text, jsonb, text[], boolean, integer, text, text, bytea, jsonb, text);
--> statement-breakpoint
CREATE FUNCTION record_form_generation(
  p_context audit_context, p_participation_id uuid, p_generation_id uuid, p_document_id uuid,
  p_form_code form_code, p_form_version text, p_sources jsonb, p_person jsonb,
  p_source_token text, p_organisation_sha256 text, p_declarations jsonb,
  p_confirmed_warnings text[], p_anlage boolean, p_size_bytes integer, p_content_sha256 text,
  p_key_id text, p_wrapped_key bytea, p_checklist jsonb DEFAULT NULL,
  p_employer_sha256 text DEFAULT NULL, p_offer_deadline date DEFAULT NULL,
  p_deadline_kind dsv_deadline_kind DEFAULT NULL
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
        'templateVersion', p_form_version, 'deadlineKind', p_deadline_kind), false);
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
-- The project's fields (ADR-0002, project setup), as 0080 wrote it, and the DSV template's pin
-- (ADR-0009, the DSV template; Slice 7 D1): `p_dsv_template_version` alone in its call
-- (`invalid_argument` with any other field), by the project's PL as themselves
-- (`actor_not_allowed`), in a `ta_tg` project (`not_ta_tg`), only while no DSV of the project was
-- generated (`template_pinned`: fixed from the first generation) and only to another version
-- (`project_unchanged`). The API checks the version exists in the form registry. Under the
-- exclusive project lock (`lock_project_setup`), so a generation, which takes the shared one,
-- never sees it change. Audited `dsv_template_pinned` (the version and the one it replaced).
DROP FUNCTION update_project(uuid, audit_context, text, text, project_type, text, uuid, jsonb);
--> statement-breakpoint
CREATE FUNCTION update_project(
  p_id uuid, p_context audit_context, p_name text DEFAULT NULL, p_customer_name text DEFAULT NULL,
  p_type project_type DEFAULT NULL, p_project_agentur_key text DEFAULT NULL,
  p_region_id uuid DEFAULT NULL, p_kug200a jsonb DEFAULT NULL,
  p_dsv_template_version text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project;
  v_fields text[] := '{}';
  v_kug200a jsonb := coalesce(p_kug200a, '{}');
  k text;
  v text;
  v_bad boolean;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  -- The DSV template's pin (ADR-0009, the DSV template; Slice 7 D1), alone in its call.
  IF p_dsv_template_version IS NOT NULL THEN
    IF p_dsv_template_version !~ '^v[1-9][0-9]{0,3}$' OR p_name IS NOT NULL
       OR p_customer_name IS NOT NULL OR p_type IS NOT NULL OR p_project_agentur_key IS NOT NULL
       OR p_region_id IS NOT NULL OR p_kug200a IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    IF NOT EXISTS (
      SELECT FROM public.project_membership m
      JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
      WHERE m.project_id = p_id AND m.staff_user_id = (p_context).staff_user_id
        AND m.role = 'project_lead') THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    IF r.type <> 'ta_tg' THEN
      RAISE EXCEPTION 'not_ta_tg';
    END IF;
    IF EXISTS (SELECT FROM public.form_generation
               WHERE project_id = p_id AND form_code::text = 'dsv') THEN
      RAISE EXCEPTION 'template_pinned';
    END IF;
    IF r.dsv_template_version IS NOT DISTINCT FROM p_dsv_template_version THEN
      RAISE EXCEPTION 'project_unchanged';
    END IF;
    UPDATE public.project SET dsv_template_version = p_dsv_template_version WHERE id = p_id;
    RETURN public.write_audit_event(p_id, NULL, 'dsv_template_pinned', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'templateVersion', p_dsv_template_version,
        'previousVersion', r.dsv_template_version)), false);
  END IF;
  IF p_name IS NOT NULL AND NOT public.project_text_valid(p_name)
     OR p_customer_name IS NOT NULL AND NOT public.project_text_valid(p_customer_name)
     OR pg_catalog.jsonb_typeof(v_kug200a) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(v_kug200a) LOOP
    IF pg_catalog.jsonb_typeof(v_kug200a -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    v := v_kug200a ->> k;
    -- An IF condition ends at its first THEN, so the CASE is assigned first.
    v_bad := CASE k
      WHEN 'tKugNumber' THEN v !~ '^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$' OR v ~* '^TK-'
      WHEN 'employerBetriebsnummer' THEN v !~ '^[0-9]{8}$'
      WHEN 'employerEconomicClass' THEN pg_catalog.char_length(v) NOT BETWEEN 1 AND 100
        OR v <> pg_catalog.btrim(v) OR v ~ '[[:cntrl:]]'
      ELSE true
    END;
    IF coalesce(v_bad, false) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END LOOP;
  IF p_name IS DISTINCT FROM r.name AND p_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF p_customer_name IS DISTINCT FROM r.customer_name AND p_customer_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'customerName');
  END IF;
  IF p_type IS DISTINCT FROM r.type AND p_type IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF EXISTS (SELECT FROM public.participation WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_participations';
    ELSIF EXISTS (SELECT FROM public.project_entry_wave WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_waves';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'type');
  END IF;
  IF p_project_agentur_key IS DISTINCT FROM r.project_agentur_key AND p_project_agentur_key IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF NOT EXISTS (SELECT FROM public.project_template_pin
                      WHERE project_id = p_id AND agentur_key = p_project_agentur_key) THEN
      RAISE EXCEPTION 'agentur_not_pinned';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'projectAgenturKey');
  END IF;
  IF p_region_id IS DISTINCT FROM r.region_id AND p_region_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
      RAISE EXCEPTION 'region_not_found';
    END IF;
    IF r.status <> 'draft' AND NOT EXISTS (
        SELECT FROM public.staff_org_role WHERE staff_user_id = (p_context).staff_user_id AND role = 'admin') THEN
      RAISE EXCEPTION 'project_not_draft';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'regionId');
  END IF;
  IF v_kug200a ? 'tKugNumber' AND (v_kug200a ->> 'tKugNumber') IS DISTINCT FROM r.t_kug_number THEN
    v_fields := pg_catalog.array_append(v_fields, 'tKugNumber');
  END IF;
  IF v_kug200a ? 'employerBetriebsnummer'
     AND (v_kug200a ->> 'employerBetriebsnummer') IS DISTINCT FROM r.employer_betriebsnummer THEN
    v_fields := pg_catalog.array_append(v_fields, 'employerBetriebsnummer');
  END IF;
  IF v_kug200a ? 'employerEconomicClass'
     AND (v_kug200a ->> 'employerEconomicClass') IS DISTINCT FROM r.employer_economic_class THEN
    v_fields := pg_catalog.array_append(v_fields, 'employerEconomicClass');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'project_unchanged';
  END IF;
  UPDATE public.project
  SET name = coalesce(p_name, name), customer_name = coalesce(p_customer_name, customer_name),
      type = coalesce(p_type, type),
      project_agentur_key = coalesce(p_project_agentur_key, project_agentur_key),
      region_id = coalesce(p_region_id, region_id),
      t_kug_number = CASE WHEN v_kug200a ? 'tKugNumber' THEN v_kug200a ->> 'tKugNumber'
        ELSE t_kug_number END,
      employer_betriebsnummer = CASE WHEN v_kug200a ? 'employerBetriebsnummer'
        THEN v_kug200a ->> 'employerBetriebsnummer' ELSE employer_betriebsnummer END,
      employer_economic_class = CASE WHEN v_kug200a ? 'employerEconomicClass'
        THEN v_kug200a ->> 'employerEconomicClass' ELSE employer_economic_class END
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_changed', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'type', CASE WHEN 'type' = ANY (v_fields) THEN p_type END,
      'projectAgenturKey', CASE WHEN 'projectAgenturKey' = ANY (v_fields) THEN p_project_agentur_key END,
      'regionId', CASE WHEN 'regionId' = ANY (v_fields) THEN p_region_id END)),
    false);
END $$;
--> statement-breakpoint

-- Audit events written only by their functions (ADR-0002), as 0088 wrote it: the DSV's generation
-- and its template's pin join the refused types.
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
      'evidence_correction_decided', 'dsv_form_generated', 'dsv_template_pinned') THEN
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

-- Grants: transfer_app executes the recreated document functions as before, the generation, the
-- project's update and the generation's currency; `dsv_source_token` stays internal.
REVOKE ALL ON FUNCTION current_document_policy, scan_form, add_document,
  record_document_upload_rejected, document_link_content, export_link_content,
  dsv_source_token, dsv_generation_current, record_form_generation, update_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_document, record_document_upload_rejected, document_link_content,
  export_link_content, dsv_generation_current, record_form_generation, update_project
  TO transfer_app;
