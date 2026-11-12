CREATE OR REPLACE FUNCTION public.open_document(p_context public.audit_context, p_document_id uuid, p_session_kind public.document_session_kind, p_session_hash text, p_link_hash text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  INSERT INTO public.document_link (token_hash, document_id, project_id, participation_id,
    session_kind, session_hash, expires_at)
  VALUES (p_link_hash, d.id, d.project_id, d.participation_id, p_session_kind, p_session_hash,
    v_expires);
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_opened', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentType', d.type, 'documentId', d.id), false);
  RETURN v_expires;
END $function$;

ALTER FUNCTION public.open_document(public.audit_context,uuid,public.document_session_kind,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.open_document(public.audit_context,uuid,public.document_session_kind,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_document(public.audit_context,uuid,public.document_session_kind,text,text) TO transfer_app;
