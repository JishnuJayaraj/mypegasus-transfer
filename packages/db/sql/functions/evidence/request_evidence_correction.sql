CREATE OR REPLACE FUNCTION public.request_evidence_correction(p_context public.audit_context, p_participation_id uuid, p_target_kind public.correction_target_kind, p_action public.correction_action, p_target_id uuid, p_wrong_person boolean, p_corrected_registered_on date, p_reason public.correction_reason, p_source text, p_field_key text DEFAULT NULL::text, p_corrected_on date DEFAULT NULL::date, p_signature_paper text DEFAULT NULL::text, p_signature_kind text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_date_target boolean := p_target_kind::text IN ('field', 'dsv_signature');
  v_shape_ok boolean := CASE p_target_kind::text
    WHEN 'document' THEN p_action::text = 'invalidate' AND p_wrong_person IS NOT NULL
      AND p_corrected_registered_on IS NULL
    WHEN 'asu_registration' THEN p_wrong_person IS NULL
      AND (p_action::text = 'supersede') = (p_corrected_registered_on IS NOT NULL)
    WHEN 'ba_reporting_task' THEN p_action::text = 'supersede' AND p_wrong_person IS NULL
      AND p_corrected_registered_on IS NULL
    WHEN 'field' THEN p_action::text = 'supersede' AND p_target_id IS NULL
      AND p_wrong_person IS NULL AND p_corrected_registered_on IS NULL
      AND p_field_key IN ('profilingDoneOn', 'withdrawnOn') AND p_corrected_on IS NOT NULL
      AND p_signature_paper IS NULL AND p_signature_kind IS NULL
    WHEN 'dsv_signature' THEN p_action::text = 'supersede' AND p_target_id IS NOT NULL
      AND p_wrong_person IS NULL AND p_corrected_registered_on IS NULL AND p_field_key IS NULL
      AND p_corrected_on IS NOT NULL
      AND p_signature_paper IN ('dsv_signed_scan', 'dsv_cancellation')
      AND p_signature_kind IN ('participant', 'customer', 'transfergesellschaft')
    ELSE false END
    AND (v_date_target OR (p_field_key IS NULL AND p_corrected_on IS NULL
      AND p_signature_paper IS NULL AND p_signature_kind IS NULL));
  v_source text := public.normalise_correction_source(p_source);
  v_roles text[];
  v_requesters text[] := '{project_lead}';
  v_corrected boolean := false;
  v_class text := 'participation_record';
  v_original date;
  v_problem text;
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_participation_id IS NULL OR p_reason IS NULL OR NOT coalesce(v_shape_ok, false)
     OR (p_target_id IS NULL AND p_target_kind::text <> 'field') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'source_invalid';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  v_roles := public.document_staff_roles(r.id, (p_context).staff_user_id);
  IF p_target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document
    WHERE id = p_target_id AND participation_id = r.id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_requesters := CASE
      WHEN d.type::text IN ('dsv_signed_scan', 'dsv_cancellation') THEN '{project_lead,back_office}'
      WHEN d.type::text IN ('tl407_form', 'kug200b_form', 'dsv_form') THEN '{}'
      ELSE '{project_lead}' END::text[];
    v_corrected := d.invalidated_by_correction IS NOT NULL;
    v_class := d.retention_class;
  ELSIF p_target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL;
  ELSIF p_target_kind::text = 'ba_reporting_task' THEN
    SELECT * INTO t FROM public.ba_reporting_task
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := t.superseded_by IS NOT NULL;
  ELSIF p_target_kind::text = 'dsv_signature' THEN
    -- The paper's scans, then the offer (ADR-0002's order).
    PERFORM FROM public.document
    WHERE dsv_offer_id = p_target_id AND participation_id = r.id
      AND type::text = p_signature_paper
    ORDER BY id FOR SHARE;
    PERFORM FROM public.dsv_offer WHERE id = p_target_id AND participation_id = r.id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_requesters := '{project_lead,back_office}';
    -- The scans' class: the signature rows are part of them (data-protection.md, DSV scans).
    v_class := 'personnel_file';
  END IF;
  IF NOT v_roles && v_requesters THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF v_corrected THEN
    RAISE EXCEPTION 'target_corrected';
  END IF;
  IF EXISTS (SELECT FROM public.evidence_correction c
             WHERE c.status::text = 'requested' AND CASE p_target_kind::text
               WHEN 'field' THEN c.participation_id = r.id AND c.field_key = p_field_key
               WHEN 'dsv_signature' THEN c.dsv_offer_id = p_target_id
                 AND c.signature_paper = p_signature_paper
                 AND c.signature_kind = p_signature_kind
               ELSE coalesce(c.document_id, c.asu_registration_id, c.ba_reporting_task_id)
                 = p_target_id END) THEN
    RAISE EXCEPTION 'correction_pending';
  END IF;
  IF p_target_kind::text = 'document' AND d.review_state::text <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  IF p_target_kind::text = 'ba_reporting_task' AND t.status::text = 'pending' THEN
    RAISE EXCEPTION 'task_pending';
  END IF;
  IF p_corrected_registered_on IS NOT NULL THEN
    IF g.channel::text = 'kug_200b' THEN
      RAISE EXCEPTION 'asu_route_kug200b';
    END IF;
    IF p_corrected_registered_on > public.berlin_today() THEN
      RAISE EXCEPTION 'registered_on_in_future';
    END IF;
    IF p_corrected_registered_on = g.registered_on THEN
      RAISE EXCEPTION 'correction_unchanged';
    END IF;
  END IF;
  IF p_target_kind::text = 'field' THEN
    SELECT f.original, f.problem INTO v_original, v_problem
    FROM public.field_correction_problem(r, p_field_key, p_corrected_on) f;
  ELSIF p_target_kind::text = 'dsv_signature' THEN
    SELECT f.original, f.problem INTO v_original, v_problem
    FROM public.signature_correction_problem(p_target_id, p_signature_paper, p_signature_kind,
      p_corrected_on) f;
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;
  INSERT INTO public.evidence_correction (id, project_id, participation_id, target_kind, action,
    document_id, asu_registration_id, ba_reporting_task_id, wrong_person,
    corrected_registered_on, field_key, dsv_offer_id, signature_paper, signature_kind,
    corrected_on, original_on, reason, source, retention_class, requested_by)
  VALUES (v_id, r.project_id, r.id, p_target_kind, p_action,
    CASE WHEN p_target_kind::text = 'document' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'asu_registration' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'ba_reporting_task' THEN p_target_id END,
    p_wrong_person, p_corrected_registered_on, p_field_key,
    CASE WHEN p_target_kind::text = 'dsv_signature' THEN p_target_id END,
    p_signature_paper, p_signature_kind,
    p_corrected_on, v_original, p_reason, v_source, v_class, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_requested', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'correctionId', v_id, 'targetKind', p_target_kind, 'action', p_action, 'reason', p_reason,
      'fieldKey', p_field_key, 'paper', p_signature_paper, 'signatureKind', p_signature_kind)),
    false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.request_evidence_correction(public.audit_context,uuid,public.correction_target_kind,public.correction_action,uuid,boolean,date,public.correction_reason,text,text,date,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_evidence_correction(public.audit_context,uuid,public.correction_target_kind,public.correction_action,uuid,boolean,date,public.correction_reason,text,text,date,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_evidence_correction(public.audit_context,uuid,public.correction_target_kind,public.correction_action,uuid,boolean,date,public.correction_reason,text,text,date,text,text) TO transfer_app;
