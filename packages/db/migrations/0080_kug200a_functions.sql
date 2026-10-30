-- Hand-written (ADR-0002, Kug 200b batches; process-and-lifecycle.md, Kug 200b batches;
-- data-protection.md, exports; ba-forms.md, the Kug 200a as built; Q195, Q197, Q203 (6), Q205):
-- the Kug 200a's header on the project (`update_project` learns the T-Kug-Nummer and the
-- personalabgebender Betrieb's Betriebsnummer and Branche/WK), and the official artifacts of an open
-- batch as export kinds: `kug200b_batch_artifact` (the Kug 200a, or the alternative list the
-- Agentur accepted) and `kug200b_batch_scans` (the members' accepted Kug 200b scans, for the
-- channels `scan_email` and `upload`). Same hardening as 0078: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. The export kinds 0079 added are compared as text here.
--
-- The full recheck at the download (the review of PR #98, Q203 (6)): unlike the internal CSV, an
-- official artifact is rechecked in full at its download, settings included, in two steps, each
-- under the project's exclusive lock, which every writer of what the artifact prints takes or
-- conflicts with: configuration and project writes (`lock_project_setup`), attendance and
-- appointments (`lock_project_setup`), every participation write, the participant's own and the
-- reviews and quarantines of documents (`lock_participation`, the shared lock). The API resolves the
-- Agentur's channel, artifact and outdated versions after taking the lock and passes them in;
-- `read_kug200b_batch_export` rechecks the PL, the batch and every member with them
-- (`export_stale`), reads what the output prints (the RV-Nummer decrypted per member, audited
-- `sensitive_read`) and its fingerprint; the API renders; `record_kug200b_batch_export` rechecks
-- again and compares the fingerprint of everything printed (`source_changed`) before it writes
-- `export_downloaded`. Nothing is stored but the audit.

-- The project's fields (ADR-0002, project setup), as 0037 wrote it, and the Kug 200a's header:
-- `p_kug200a`, an object whose keys present are set (a string) or cleared (null): `tKugNumber`
-- (as it follows the form's printed `TK-`, never repeating it), `employerBetriebsnummer` (eight
-- digits) and `employerEconomicClass` (trimmed, 1–100, no control characters); any other shape is
-- `invalid_argument`. Allowed in every project status; audited in `project_changed` by field name,
-- never a value.
DROP FUNCTION update_project(uuid, audit_context, text, text, project_type, text, uuid);
--> statement-breakpoint
CREATE FUNCTION update_project(
  p_id uuid, p_context audit_context, p_name text DEFAULT NULL, p_customer_name text DEFAULT NULL,
  p_type project_type DEFAULT NULL, p_project_agentur_key text DEFAULT NULL,
  p_region_id uuid DEFAULT NULL, p_kug200a jsonb DEFAULT NULL
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

-- A batch's export issued (data-protection.md, exports; D24), as 0078 wrote it, for every batch
-- kind: the index, the official artifact and, for the channels `scan_email` and `upload` only, the
-- scans (`export_not_applicable` for a paper channel, whose Kug 200a goes with the originals).
CREATE OR REPLACE FUNCTION create_kug200b_batch_export_link(
  p_context audit_context, p_kind export_kind, p_batch_id uuid, p_session_hash text,
  p_link_hash text, p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact,
  p_outdated_versions text[]
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  v_rows jsonb;
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_kind IS NULL
     OR p_kind::text NOT IN ('kug200b_batch_index', 'kug200b_batch_artifact', 'kug200b_batch_scans')
     OR p_batch_id IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_artifact IS NULL OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  IF p_kind::text = 'kug200b_batch_scans' AND b.channel NOT IN ('scan_email', 'upload') THEN
    RAISE EXCEPTION 'export_not_applicable';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  INSERT INTO public.export_link (token_hash, project_id, kind, document_ids, batch_id,
    staff_user_id, session_hash, expires_at)
  VALUES (p_link_hash, b.project_id, p_kind, '{}', b.id, (p_context).staff_user_id,
    p_session_hash, v_expires);
  PERFORM public.write_audit_event(b.project_id, NULL, 'export_created', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', p_kind,
      'count', b.member_count), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- The index's content, as 0078 wrote it, for an index link only (`export_link_invalid` for the
-- official kinds, which have their own two steps).
CREATE OR REPLACE FUNCTION kug200b_batch_export_content(
  p_context audit_context, p_link_hash text, p_session_hash text
) RETURNS TABLE (
  participation_id uuid, document_id uuid, last_name text, first_name text, form_version text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
  b public.kug200b_batch;
  m public.kug200b_batch_member;
  r public.participation;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL OR l.kind::text <> 'kug200b_batch_index' THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(l.project_id));
  SELECT * INTO b FROM public.kug200b_batch WHERE id = l.batch_id;
  IF NOT public.kug200b_batch_lead(b.project_id, l.staff_user_id) OR b.status <> 'open' THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id LOOP
    SELECT * INTO r FROM public.participation WHERE id = m.participation_id;
    SELECT * INTO d FROM public.document WHERE id = m.document_id;
    IF public.kug200b_member_problem(r, d, b.agentur_key, '{}', m) IS NOT NULL THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', b.member_count), false);
  RETURN QUERY
    SELECT m2.participation_id, m2.document_id, i.last_name, i.first_name, m2.form_version
    FROM public.kug200b_batch_member m2
    LEFT JOIN public.participant_identity i ON i.participation_id = m2.participation_id
    WHERE m2.batch_id = b.id
    ORDER BY i.last_name, i.first_name, m2.participation_id;
END $$;
--> statement-breakpoint

-- Internal helpers (no grant).

-- The batch of a live official link (`export_link_invalid` otherwise), its project locked
-- exclusive, rechecked in full with what the API resolved under the same lock: the user still the
-- project's PL, the batch still open, the channel and artifact unchanged and every member still
-- usable, open, placed with the batch's Agentur, on its route and of a version the Agentur accepts
-- (`export_stale`, the rows in DETAIL). Returns the batch.
CREATE FUNCTION lock_kug200b_official_export(
  p_context audit_context, p_link_hash text, p_session_hash text,
  p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact, p_outdated_versions text[]
) RETURNS kug200b_batch LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
  b public.kug200b_batch;
  v_rows jsonb;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL
     OR l.kind::text NOT IN ('kug200b_batch_artifact', 'kug200b_batch_scans') THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  IF p_artifact IS NULL OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(l.project_id));
  SELECT * INTO b FROM public.kug200b_batch WHERE id = l.batch_id;
  IF NOT public.kug200b_batch_lead(b.project_id, l.staff_user_id) OR b.status <> 'open' THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'export_stale' USING DETAIL = v_rows::text;
  END IF;
  RETURN b;
END $$;
--> statement-breakpoint

-- Everything an official artifact prints, as one value (never a sensitive plaintext: the
-- RV-Nummer as its ciphertext's SHA-256), in the list's order (last name, first name), so a
-- fingerprint over it changes with anything printed. The Kug 200a: the project's customer and
-- header fields, the batch's Berlin day, per member the name, the address, the RV-Nummer's
-- digest, the effective TG dates, where declaration 17 in force is (`in_packet`: on the member's
-- scan in the batch; `other_paper`: on another usable paper, which the packet doesn't carry;
-- `none`: none in force; Q205 (4)) and the Berlin dates of the project's scheduled info events
-- attended. The scans: per member the scan,
-- its media type and content digest. Enum values are compared as text: a SQL function's body is
-- checked when created, in the same migration run that may have added them.
CREATE FUNCTION kug200b_batch_export_sources(p_batch kug200b_batch, p_kind text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'kug200b_batch_scans' THEN pg_catalog.jsonb_build_object('members', (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'participationId', m.participation_id, 'documentId', d.id,
          'mediaType', d.media_type, 'contentSha256', d.content_sha256)
        ORDER BY i.last_name, i.first_name, m.participation_id)
      FROM public.kug200b_batch_member m
      JOIN public.document d ON d.id = m.document_id
      LEFT JOIN public.participant_identity i ON i.participation_id = m.participation_id
      WHERE m.batch_id = p_batch.id))
    ELSE pg_catalog.jsonb_build_object(
      'project', (SELECT pg_catalog.jsonb_build_object('customerName', p.customer_name,
          'tKugNumber', p.t_kug_number, 'employerBetriebsnummer', p.employer_betriebsnummer,
          'employerEconomicClass', p.employer_economic_class)
        FROM public.project p WHERE p.id = p_batch.project_id),
      'createdOn', pg_catalog.to_char(p_batch.created_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD'),
      'members', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'participationId', m.participation_id, 'documentId', m.document_id,
            'firstName', i.first_name, 'lastName', i.last_name,
            'address', CASE WHEN pd.address_street IS NOT NULL THEN pg_catalog.jsonb_build_object(
              'street', pd.address_street, 'postalCode', pd.address_postal_code,
              'city', pd.address_city, 'country', pd.address_country) END,
            'insuranceNumberSha256', pg_catalog.encode(
              pg_catalog.sha256(x.pension_insurance_number), 'hex'),
            'tgStart', pg_catalog.to_char(coalesce(r.tg_start, w.default_tg_start), 'YYYY-MM-DD'),
            'tgEnd', pg_catalog.to_char(coalesce(r.tg_end, w.default_tg_end), 'YYYY-MM-DD'),
            'declaration17', coalesce((
              SELECT CASE WHEN c.document_id = m.document_id THEN 'in_packet'
                ELSE 'other_paper' END
              FROM public.consent_record c
              JOIN public.document cd ON cd.id = c.document_id
              WHERE c.participation_id = m.participation_id
                AND c.purpose::text = 'kug200b_profile_access' AND c.ended_at IS NULL
                AND cd.deleted_at IS NULL AND cd.quarantined_at IS NULL
                AND cd.invalidated_by_correction IS NULL
              ORDER BY c.document_id = m.document_id DESC LIMIT 1), 'none'),
            'infoEventDates', coalesce((
              SELECT pg_catalog.jsonb_agg(DISTINCT pg_catalog.to_char(
                  a.starts_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD'))
              FROM public.appointment_booking k
              JOIN public.appointment a ON a.id = k.appointment_id
              WHERE k.participation_id = m.participation_id AND k.status::text = 'booked'
                AND k.attendance::text = 'attended' AND a.kind::text = 'info_event'
                AND a.status::text = 'scheduled' AND a.project_id = p_batch.project_id), '[]'))
          ORDER BY i.last_name, i.first_name, m.participation_id)
        FROM public.kug200b_batch_member m
        JOIN public.participation r ON r.id = m.participation_id
        LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
        LEFT JOIN public.participant_identity i ON i.participation_id = m.participation_id
        LEFT JOIN public.participant_details pd ON pd.participation_id = m.participation_id
        LEFT JOIN public.participant_identifier_data x ON x.participation_id = m.participation_id
        WHERE m.batch_id = p_batch.id))
  END
$$;
--> statement-breakpoint

-- The fingerprint of an official artifact: its kind, the batch's channel and artifact, the
-- organisation configuration's digest the API printed from, and every source it prints.
CREATE FUNCTION kug200b_batch_export_fingerprint(
  p_batch kug200b_batch, p_kind text, p_organisation_sha256 text
) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 'kug200b-batch-export:v1', 'kind', p_kind, 'channel', p_batch.channel,
    'artifact', p_batch.artifact, 'organisation', p_organisation_sha256,
    'sources', public.kug200b_batch_export_sources(p_batch, p_kind))::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- An official artifact's read (the first step): the batch rechecked in full under the exclusive
-- lock (`lock_kug200b_official_export`), then what it prints and its fingerprint. For the Kug 200a
-- or the alternative list each member's RV-Nummer is decrypted with the field key (a purpose-bound
-- read of the PL, as `read_kug200b_values`), each read audited `sensitive_read` (key
-- `pensionInsuranceNumber`); for the scans each member's scan with its key material. Writes no
-- `export_downloaded`: the record does. Returns `{ kind, channel, artifact, fingerprint, sources,
-- insuranceNumbers, files }`, the one its kind doesn't use null.
CREATE FUNCTION read_kug200b_batch_export(
  p_context audit_context, p_link_hash text, p_session_hash text,
  p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact, p_outdated_versions text[],
  p_organisation_sha256 text, p_key text, p_key_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  l public.export_link;
  x public.participant_identifier_data;
  m public.kug200b_batch_member;
  v_numbers jsonb := '{}';
  v_files jsonb;
BEGIN
  IF p_organisation_sha256 IS NULL OR p_organisation_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_official_export(p_context, p_link_hash, p_session_hash, p_channel,
    p_artifact, p_outdated_versions);
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.kind::text = 'kug200b_batch_scans' THEN
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('documentId', d.id,
        'participationId', d.participation_id, 'type', d.type, 'mediaType', d.media_type,
        'keyId', d.key_id, 'wrappedKey', pg_catalog.encode(d.wrapped_key, 'base64'))
      ORDER BY i.last_name, i.first_name, m2.participation_id)
    INTO v_files
    FROM public.kug200b_batch_member m2
    JOIN public.document d ON d.id = m2.document_id
    LEFT JOIN public.participant_identity i ON i.participation_id = m2.participation_id
    WHERE m2.batch_id = b.id;
  ELSE
    IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
       OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id
             ORDER BY participation_id LOOP
      SELECT * INTO x FROM public.participant_identifier_data
      WHERE participation_id = m.participation_id;
      IF x.pension_insurance_number IS NULL THEN
        CONTINUE;
      END IF;
      IF x.key_id <> p_key_id THEN
        RAISE EXCEPTION 'key_unknown';
      END IF;
      v_numbers := v_numbers || pg_catalog.jsonb_build_object(m.participation_id::text,
        public.open_sensitive_value(m.participation_id, 'pensionInsuranceNumber',
          x.pension_insurance_number, p_key));
      PERFORM public.write_audit_event(b.project_id, m.participation_id, 'sensitive_read',
        p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('key', 'pensionInsuranceNumber'), false);
    END LOOP;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'kind', l.kind, 'channel', b.channel, 'artifact', b.artifact,
    'fingerprint', public.kug200b_batch_export_fingerprint(b, l.kind::text, p_organisation_sha256),
    'sources', public.kug200b_batch_export_sources(b, l.kind::text),
    'insuranceNumbers', CASE WHEN l.kind::text = 'kug200b_batch_artifact' THEN v_numbers END,
    'files', v_files);
END $$;
--> statement-breakpoint

-- An official artifact's record (the second step, after the API rendered it): the batch
-- rechecked in full again under the exclusive lock, then the fingerprint of everything printed
-- compared with the read's (`source_changed`: something printed moved in between, nothing is
-- served). Audited `export_downloaded` (kind and count, project-level); stores no file.
CREATE FUNCTION record_kug200b_batch_export(
  p_context audit_context, p_link_hash text, p_session_hash text,
  p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact, p_outdated_versions text[],
  p_organisation_sha256 text, p_fingerprint text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  l public.export_link;
BEGIN
  IF p_organisation_sha256 IS NULL OR p_organisation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_official_export(p_context, p_link_hash, p_session_hash, p_channel,
    p_artifact, p_outdated_versions);
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF public.kug200b_batch_export_fingerprint(b, l.kind::text, p_organisation_sha256)
     <> p_fingerprint THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  PERFORM public.write_audit_event(b.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', b.member_count), false);
END $$;
--> statement-breakpoint

-- The batch of a live official link of this staff user and session (`export_link_invalid`
-- otherwise), so the API takes its project's lock and resolves the Agentur's settings before the
-- read. Reads nothing else; not audited.
CREATE FUNCTION export_link_batch(p_context audit_context, p_link_hash text, p_session_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL
     OR l.kind::text NOT IN ('kug200b_batch_artifact', 'kug200b_batch_scans') THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  RETURN l.batch_id;
END $$;
--> statement-breakpoint

-- What an open batch's Kug 200a would print, for its PL's handwriting checklist before printing
-- (the tab "Agentur"; Q197 (8)): the sources as the read takes them, the RV-Nummer as its
-- ciphertext's digest (its presence only; nothing is decrypted, nothing audited). A batch the user
-- doesn't lead is `batch_not_found` whatever its state.
CREATE FUNCTION kug200b_batch_print_sources(p_context audit_context, p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  SELECT * INTO b FROM public.kug200b_batch WHERE id = p_batch_id;
  IF NOT FOUND OR NOT public.kug200b_batch_lead(b.project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'batch_not_found';
  END IF;
  RETURN public.kug200b_batch_export_sources(b, 'kug200b_batch_artifact');
END $$;
--> statement-breakpoint

-- Grants: the two steps, the link's batch and the checklist's sources; the helpers none.
REVOKE ALL ON FUNCTION lock_kug200b_official_export, kug200b_batch_export_sources,
  kug200b_batch_export_fingerprint, read_kug200b_batch_export, record_kug200b_batch_export,
  export_link_batch, kug200b_batch_print_sources, update_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION read_kug200b_batch_export, record_kug200b_batch_export,
  export_link_batch, kug200b_batch_print_sources, update_project TO transfer_app;
