CREATE OR REPLACE FUNCTION public.create_exception_evidence_record(p_context public.audit_context, p_participation_id uuid, p_kind public.exception_evidence_kind, p_document_ids uuid[], p_agentur_key text, p_reference text, p_confirmed_on date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.create_exception_evidence_record(public.audit_context,uuid,public.exception_evidence_kind,uuid[],text,text,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_exception_evidence_record(public.audit_context,uuid,public.exception_evidence_kind,uuid[],text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_exception_evidence_record(public.audit_context,uuid,public.exception_evidence_kind,uuid[],text,text,date) TO transfer_app;
