CREATE OR REPLACE FUNCTION public.delete_document(p_context public.audit_context, p_document_id uuid, p_reason public.document_delete_reason, p_token_hash text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.delete_document(public.audit_context,uuid,public.document_delete_reason,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.delete_document(public.audit_context,uuid,public.document_delete_reason,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_document(public.audit_context,uuid,public.document_delete_reason,text) TO transfer_app;
