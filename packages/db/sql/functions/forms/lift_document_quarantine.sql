CREATE OR REPLACE FUNCTION public.lift_document_quarantine(p_context public.audit_context, p_document_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  IF NOT v_roles && (SELECT quarantine_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version)
     OR d.quarantined_by IS DISTINCT FROM (p_context).staff_user_id
       AND NOT 'project_lead' = ANY (v_roles) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NULL THEN
    RAISE EXCEPTION 'document_not_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  IF EXISTS (SELECT FROM public.evidence_correction
             WHERE document_id = d.id AND status::text = 'requested') THEN
    RAISE EXCEPTION 'correction_pending';
  END IF;
  UPDATE public.document SET quarantine_reason = NULL, quarantined_by = NULL,
    quarantined_at = NULL, quarantine_lifted_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id,
    'document_quarantine_lifted', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $function$;

ALTER FUNCTION public.lift_document_quarantine(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lift_document_quarantine(public.audit_context,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lift_document_quarantine(public.audit_context,uuid) TO transfer_app;
