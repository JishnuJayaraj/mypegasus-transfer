CREATE OR REPLACE FUNCTION public.read_kug200b_batch_export(p_context public.audit_context, p_link_hash text, p_session_hash text, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[], p_organisation_sha256 text, p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.read_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.read_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text,text) TO transfer_app;
