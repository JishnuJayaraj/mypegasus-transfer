CREATE OR REPLACE FUNCTION public.create_export_link(p_context public.audit_context, p_kind public.export_kind, p_document_ids uuid[], p_session_hash text, p_link_hash text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.create_export_link(public.audit_context,public.export_kind,uuid[],text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_export_link(public.audit_context,public.export_kind,uuid[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_export_link(public.audit_context,public.export_kind,uuid[],text,text) TO transfer_app;
