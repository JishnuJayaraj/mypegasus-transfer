CREATE OR REPLACE FUNCTION public.review_reconciliation(p_context public.audit_context, p_reconciliation_id uuid, p_outcome text, p_code text, p_source text, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tg_entry_reconciliation;
  r public.participation;
  v_source text := CASE WHEN p_source IS NOT NULL THEN public.normalise_correction_source(p_source) END;
  v_open text[];
BEGIN
  IF p_reconciliation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_outcome IS NULL OR p_outcome NOT IN ('no_objection', 'clarification_requested',
       'resolved_no_objection', 'escalated_to_dpo')
     OR (p_outcome = 'clarification_requested') <> (p_code IS NOT NULL)
     OR p_code IS NOT NULL AND p_code NOT IN ('evidence_unclear', 'date_unclear', 'other_documented')
     OR (p_outcome = 'no_objection') <> (p_source IS NULL)
     OR p_source IS NOT NULL AND (v_source IS NULL OR pg_catalog.char_length(v_source) > 200) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project and participation never change, so they can be read before the locks.
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_not_found'; END IF;
  PERFORM public.assert_context(p_context, t.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(t.project_id));
  SELECT * INTO r FROM public.participation WHERE id = t.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id FOR UPDATE;
  IF t.reconciled_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'four_eyes'; END IF;
  IF t.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_reconciliation'; END IF;
  v_open := CASE t.stage WHEN 'requested' THEN '{no_objection,clarification_requested}'::text[]
    WHEN 'replied' THEN '{resolved_no_objection,escalated_to_dpo,clarification_requested}'::text[]
    WHEN 'escalated_to_dpo' THEN '{resolved_no_objection}'::text[] ELSE '{}'::text[] END;
  IF pg_catalog.cardinality(v_open) = 0 THEN RAISE EXCEPTION 'not_awaiting'; END IF;
  IF NOT p_outcome = ANY (v_open) THEN RAISE EXCEPTION 'outcome_not_allowed'; END IF;
  UPDATE public.tg_entry_reconciliation SET stage = p_outcome, revision = t.revision + 1
  WHERE id = t.id RETURNING * INTO t;
  INSERT INTO public.tg_entry_reconciliation_step (project_id, participation_id,
    reconciliation_id, seq, kind, code, source, by)
  VALUES (t.project_id, t.participation_id, t.id, t.revision, p_outcome, p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'reconciliation_reviewed',
    p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('reconciliationId', t.id,
      'outcome', p_outcome, 'reasonCode', p_code)), false);
  RETURN t.id;
END $function$;

ALTER FUNCTION public.review_reconciliation(public.audit_context,uuid,text,text,text,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.review_reconciliation(public.audit_context,uuid,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_reconciliation(public.audit_context,uuid,text,text,text,integer) TO transfer_app;
