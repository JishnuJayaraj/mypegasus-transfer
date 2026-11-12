CREATE OR REPLACE FUNCTION public.decide_evidence_correction(p_context public.audit_context, p_correction_id uuid, p_approve boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c public.evidence_correction;
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_new uuid;
  v_purge uuid;
  v_original date;
  v_problem text;
BEGIN
  IF p_correction_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project, participation and target never change, so they can be read before the lock.
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_not_found';
  END IF;
  PERFORM public.assert_context(p_context, c.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(c.project_id));
  SELECT * INTO r FROM public.participation WHERE id = c.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF c.target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document WHERE id = c.document_id FOR UPDATE;
  ELSIF c.target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration WHERE id = c.asu_registration_id FOR UPDATE;
  ELSIF c.target_kind::text = 'ba_reporting_task' THEN
    SELECT * INTO t FROM public.ba_reporting_task WHERE id = c.ba_reporting_task_id FOR UPDATE;
  ELSIF c.target_kind::text = 'dsv_signature' THEN
    PERFORM FROM public.document
    WHERE dsv_offer_id = c.dsv_offer_id AND type::text = c.signature_paper ORDER BY id FOR UPDATE;
    PERFORM FROM public.dsv_offer WHERE id = c.dsv_offer_id FOR UPDATE;
    PERFORM FROM public.dsv_contract WHERE dsv_offer_id = c.dsv_offer_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id FOR UPDATE;
  IF c.status::text <> 'requested' THEN
    RAISE EXCEPTION 'correction_not_pending';
  END IF;
  IF c.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF p_approve THEN
    IF c.target_kind::text = 'document' THEN
      IF d.deleted_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      UPDATE public.document SET invalidated_by_correction = c.id,
        deleted_at = CASE WHEN c.wrong_person THEN now() END,
        deleted_by = CASE WHEN c.wrong_person THEN 'user'::public.actor_type END,
        deleted_by_staff_user_id = CASE WHEN c.wrong_person THEN (p_context).staff_user_id END,
        delete_reason = CASE WHEN c.wrong_person THEN 'wrong_person'::public.document_delete_reason END,
        file_name = CASE WHEN c.wrong_person THEN NULL ELSE file_name END
      WHERE id = d.id;
      IF c.wrong_person THEN
        v_purge := d.id;
      END IF;
    ELSIF c.target_kind::text = 'asu_registration' THEN
      IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF c.action::text = 'invalidate' THEN
        UPDATE public.asu_registration SET invalidated_by = c.id WHERE id = g.id;
      ELSE
        UPDATE public.asu_registration SET superseded_by = c.id WHERE id = g.id;
        INSERT INTO public.asu_registration (id, project_id, participation_id, channel,
          registered_on, recorded_by, proof_kind, proof_document_id, attestation_source,
          proof_linked_by, proof_linked_at, correction_id)
        -- As 0088: the PL's attestation carries over, a BA confirmation is linked again (Q209 (3)).
        VALUES (pg_catalog.gen_random_uuid(), g.project_id, g.participation_id, g.channel,
          c.corrected_registered_on, (p_context).staff_user_id,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.proof_kind END,
          NULL,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.attestation_source END,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.proof_linked_by END,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN now() END, c.id);
      END IF;
    ELSIF c.target_kind::text = 'ba_reporting_task' THEN
      IF t.superseded_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind,
        subject_date, amendment_id, replaces_task_id, correction_id)
      VALUES (t.participation_id, t.project_id, t.reporting_kind, t.subject_date, t.amendment_id,
        t.id, c.id)
      RETURNING id INTO v_new;
      UPDATE public.ba_reporting_task SET superseded_by = v_new WHERE id = t.id;
    ELSIF c.target_kind::text = 'field' THEN
      SELECT f.original, f.problem INTO v_original, v_problem
      FROM public.field_correction_problem(r, c.field_key, c.corrected_on) f;
      IF v_original IS DISTINCT FROM c.original_on THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
      END IF;
      IF c.field_key = 'profilingDoneOn' THEN
        UPDATE public.participation SET profiling_done_on = c.corrected_on WHERE id = r.id;
      ELSE
        UPDATE public.participation SET withdrawn_on = c.corrected_on WHERE id = r.id;
      END IF;
    ELSE
      SELECT f.original, f.problem INTO v_original, v_problem
      FROM public.signature_correction_problem(c.dsv_offer_id, c.signature_paper,
        c.signature_kind, c.corrected_on) f;
      IF v_original IS DISTINCT FROM c.original_on THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
      END IF;
      WITH superseded AS (
        UPDATE public.dsv_scan_signature s SET superseded_by = c.id
        FROM public.document x
        WHERE x.id = s.document_id AND x.dsv_offer_id = c.dsv_offer_id
          AND x.type::text = c.signature_paper AND x.review_state = 'accepted'
          AND x.deleted_at IS NULL AND x.invalidated_by_correction IS NULL
          AND s.kind = c.signature_kind AND s.superseded_by IS NULL
        RETURNING s.project_id, s.participation_id, s.document_id, s.kind)
      INSERT INTO public.dsv_scan_signature (project_id, participation_id, document_id, kind,
        signed_on, correction_id)
      SELECT project_id, participation_id, document_id, kind, c.corrected_on, c.id
      FROM superseded;
      IF c.signature_paper = 'dsv_signed_scan' THEN
        UPDATE public.dsv_contract k SET
          participant_signed_on = CASE WHEN c.signature_kind = 'participant'
            AND k.participant_signed_on = c.original_on THEN c.corrected_on
            ELSE k.participant_signed_on END,
          customer_signed_on = CASE WHEN c.signature_kind = 'customer'
            AND k.customer_signed_on = c.original_on THEN c.corrected_on
            ELSE k.customer_signed_on END,
          tg_signed_on = CASE WHEN c.signature_kind = 'transfergesellschaft'
            AND k.tg_signed_on = c.original_on THEN c.corrected_on ELSE k.tg_signed_on END
        WHERE k.dsv_offer_id = c.dsv_offer_id;
        UPDATE public.dsv_contract k SET fully_executed_on =
          greatest(k.participant_signed_on, k.customer_signed_on, k.tg_signed_on)
        WHERE k.dsv_offer_id = c.dsv_offer_id AND k.fully_executed_on IS NOT NULL;
      END IF;
    END IF;
  END IF;
  UPDATE public.evidence_correction SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.correction_status,
    decided_by = (p_context).staff_user_id, decided_at = now()
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_decided', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'correctionId', c.id, 'targetKind', c.target_kind, 'action', c.action, 'reason', c.reason,
      'fieldKey', c.field_key, 'paper', c.signature_paper, 'signatureKind', c.signature_kind,
      'decision', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END)), false);
  RETURN v_purge;
END $function$;

ALTER FUNCTION public.decide_evidence_correction(public.audit_context,uuid,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.decide_evidence_correction(public.audit_context,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_evidence_correction(public.audit_context,uuid,boolean) TO transfer_app;
