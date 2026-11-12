CREATE OR REPLACE FUNCTION public.add_document(p_context public.audit_context, p_participation_id uuid, p_id uuid, p_type public.document_type, p_media_type public.document_media_type, p_size_bytes integer, p_content_sha256 text, p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL::text, p_scan_origin public.scan_origin DEFAULT NULL::public.scan_origin, p_generation_document_id uuid DEFAULT NULL::uuid, p_dsv jsonb DEFAULT NULL::jsonb)
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

ALTER FUNCTION public.add_document(public.audit_context,uuid,uuid,public.document_type,public.document_media_type,integer,text,text,text,bytea,text,public.scan_origin,uuid,jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.add_document(public.audit_context,uuid,uuid,public.document_type,public.document_media_type,integer,text,text,text,bytea,text,public.scan_origin,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_document(public.audit_context,uuid,uuid,public.document_type,public.document_media_type,integer,text,text,text,bytea,text,public.scan_origin,uuid,jsonb) TO transfer_app;
