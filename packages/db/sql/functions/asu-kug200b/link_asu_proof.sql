CREATE OR REPLACE FUNCTION public.link_asu_proof(p_context public.audit_context, p_participation_id uuid, p_registration_id uuid, p_document_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
BEGIN
  IF p_participation_id IS NULL OR p_registration_id IS NULL OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{consultant}');
  SELECT * INTO d FROM public.document
  WHERE id = p_document_id AND participation_id = r.id AND type = 'asu_proof'
    AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  IF d.review_state <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  SELECT * INTO g FROM public.asu_registration
  WHERE id = p_registration_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asu_registration_not_found';
  END IF;
  IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
    RAISE EXCEPTION 'asu_registration_corrected';
  END IF;
  IF g.proof_kind IS NOT NULL THEN
    RAISE EXCEPTION 'asu_proof_present';
  END IF;
  UPDATE public.asu_registration SET proof_kind = 'ba_confirmation', proof_document_id = d.id,
    proof_linked_by = (p_context).staff_user_id, proof_linked_at = now()
  WHERE id = g.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_proof_linked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('registrationId', g.id, 'documentId', d.id),
    false);
END $function$;

ALTER FUNCTION public.link_asu_proof(public.audit_context,uuid,uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.link_asu_proof(public.audit_context,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_asu_proof(public.audit_context,uuid,uuid,uuid) TO transfer_app;
