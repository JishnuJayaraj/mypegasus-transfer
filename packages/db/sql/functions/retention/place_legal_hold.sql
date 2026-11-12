CREATE OR REPLACE FUNCTION public.place_legal_hold(p_context public.audit_context, p_participation_id uuid, p_classes text[], p_record_kinds text[], p_document_ids uuid[], p_reason text, p_basis text, p_expected_active uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  p public.participation;
  v_id uuid;
  v_active uuid[];
BEGIN
  IF p_classes IS NULL OR p_record_kinds IS NULL OR p_document_ids IS NULL
     OR p_expected_active IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('litigation', 'authority_request', 'documented_dispute', 'dpo_instruction')
     OR p_basis IS NULL OR pg_catalog.char_length(p_basis) NOT BETWEEN 1 AND 200
     OR p_basis <> pg_catalog.btrim(p_basis) OR p_basis ~ '[[:cntrl:]]'
     OR NOT p_classes <@ '{personnel_file,health_record,form_working_copy,evidence_set}'::text[]
     OR NOT p_record_kinds <@ '{dsv_offer,dsv_contract,dsv_scan_signature,participant_reminder,appointment_booking,consent_record,participant_channel,participant_details,participant_profile,participant_profiling,participant_profiling_assessment,participant_health_data,participant_profiling_health_assessment}'::text[] THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  p := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(p.id, (p_context).staff_user_id)
     && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.document WHERE id = ANY (p_document_ids) ORDER BY id FOR SHARE;
  IF (SELECT count(*) FROM public.document WHERE id = ANY (p_document_ids)
      AND participation_id = p.id) <> pg_catalog.cardinality(ARRAY(SELECT DISTINCT unnest(p_document_ids))) THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_active FROM (
    SELECT id FROM public.legal_hold WHERE participation_id = p.id AND released_at IS NULL
    ORDER BY id FOR UPDATE) h;
  IF v_active IS DISTINCT FROM ARRAY(SELECT DISTINCT unnest(p_expected_active) ORDER BY 1) THEN
    RAISE EXCEPTION 'stale_holds';
  END IF;
  IF pg_catalog.cardinality(p_classes) + pg_catalog.cardinality(p_record_kinds)
     + pg_catalog.cardinality(p_document_ids) = 0 THEN
    RAISE EXCEPTION 'hold_scope_empty';
  END IF;
  IF p_classes @> '{personnel_file,health_record,form_working_copy,evidence_set}'::text[] THEN
    RAISE EXCEPTION 'hold_scope_too_broad';
  END IF;
  INSERT INTO public.legal_hold (project_id, participation_id, classes, record_kinds, document_ids,
    reason, basis, placed_by)
  VALUES (p.project_id, p.id, ARRAY(SELECT DISTINCT unnest(p_classes) ORDER BY 1),
    ARRAY(SELECT DISTINCT unnest(p_record_kinds) ORDER BY 1),
    ARRAY(SELECT DISTINCT unnest(p_document_ids) ORDER BY 1), p_reason, p_basis,
    (p_context).staff_user_id)
  RETURNING id INTO v_id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'legal_hold_placed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('holdId', v_id, 'reason', p_reason,
      'classes', (SELECT classes FROM public.legal_hold WHERE id = v_id),
      'recordKinds', (SELECT record_kinds FROM public.legal_hold WHERE id = v_id),
      'documentCount', (SELECT pg_catalog.cardinality(document_ids) FROM public.legal_hold WHERE id = v_id)),
    false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.place_legal_hold(public.audit_context,uuid,text[],text[],uuid[],text,text,uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.place_legal_hold(public.audit_context,uuid,text[],text[],uuid[],text,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_legal_hold(public.audit_context,uuid,text[],text[],uuid[],text,text,uuid[]) TO transfer_app;
