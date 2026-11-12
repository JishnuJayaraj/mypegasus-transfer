CREATE OR REPLACE FUNCTION public.record_document_upload_rejected(p_context public.audit_context, p_participation_id uuid, p_type public.document_type, p_code text, p_token_hash text DEFAULT NULL::text)
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
END $function$;

ALTER FUNCTION public.record_document_upload_rejected(public.audit_context,uuid,public.document_type,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_document_upload_rejected(public.audit_context,uuid,public.document_type,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_document_upload_rejected(public.audit_context,uuid,public.document_type,text,text) TO transfer_app;
