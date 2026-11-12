CREATE OR REPLACE FUNCTION public.create_kug200b_batch(p_context public.audit_context, p_project_id uuid, p_batch_id uuid, p_agentur_key text, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_document_ids uuid[], p_outdated_versions text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  d public.document;
  r public.participation;
  v_problem text;
  v_rows jsonb := '[]';
  v_count integer := pg_catalog.cardinality(p_document_ids);
BEGIN
  IF p_project_id IS NULL OR p_batch_id IS NULL OR p_artifact IS NULL
     OR p_agentur_key IS NULL OR p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR p_document_ids IS NULL OR v_count NOT BETWEEN 1 AND 200
     OR pg_catalog.array_position(p_document_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_document_ids) i) <> v_count
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.lock_kug200b_batch_project(p_context, p_project_id, 'project_not_found');
  IF p_channel IS NULL THEN
    RAISE EXCEPTION 'batch_settings_missing';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE id = ANY (p_document_ids) AND project_id = p_project_id) <> v_count THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT participation_id) FROM public.document
      WHERE id = ANY (p_document_ids)) <> v_count THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM FROM public.participation p
  WHERE p.id IN (SELECT participation_id FROM public.document WHERE id = ANY (p_document_ids))
  ORDER BY p.id FOR UPDATE;
  PERFORM FROM public.document WHERE id = ANY (p_document_ids) ORDER BY id FOR SHARE;
  FOR d IN SELECT * FROM public.document WHERE id = ANY (p_document_ids)
           ORDER BY participation_id LOOP
    SELECT * INTO r FROM public.participation WHERE id = d.participation_id;
    v_problem := public.kug200b_member_problem(r, d, p_agentur_key, p_outdated_versions, NULL);
    IF v_problem IS NOT NULL THEN
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'participationId', r.id, 'documentId', d.id, 'reason', v_problem));
    END IF;
  END LOOP;
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  INSERT INTO public.kug200b_batch (id, project_id, agentur_key, channel, artifact, member_count,
    created_by)
  VALUES (p_batch_id, p_project_id, p_agentur_key, p_channel, p_artifact, v_count,
    (p_context).staff_user_id);
  INSERT INTO public.kug200b_batch_member (batch_id, project_id, participation_id, document_id,
    form_version, asu_channel, placement_agentur_key)
  SELECT p_batch_id, p_project_id, x.participation_id, x.id, x.form_version, a.channel,
    p_agentur_key
  FROM public.document x
  LEFT JOIN public.asu_record a ON a.participation_id = x.participation_id
  WHERE x.id = ANY (p_document_ids);
  PERFORM public.write_audit_event(p_project_id, NULL, 'kug200b_batch_created', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', p_batch_id,
      'agenturKey', p_agentur_key, 'channel', p_channel, 'artifact', p_artifact,
      'count', v_count), false);
  RETURN p_batch_id;
END $function$;

ALTER FUNCTION public.create_kug200b_batch(public.audit_context,uuid,uuid,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,uuid[],text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_kug200b_batch(public.audit_context,uuid,uuid,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,uuid[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_kug200b_batch(public.audit_context,uuid,uuid,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,uuid[],text[]) TO transfer_app;
