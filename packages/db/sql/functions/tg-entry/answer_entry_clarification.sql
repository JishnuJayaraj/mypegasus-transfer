CREATE OR REPLACE FUNCTION public.answer_entry_clarification(p_context public.audit_context, p_clarification_id uuid, p_kind text, p_code text, p_source text, p_status_version integer, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c public.entry_clarification;
  r public.participation;
  v_source text := public.normalise_correction_source(p_source);
BEGIN
  IF p_clarification_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_kind IS NULL OR p_kind NOT IN ('instructed', 'requested') OR p_code IS NULL
     OR p_kind = 'instructed' AND p_code NOT IN ('legal_advice_obtained', 'dpo_instruction',
       'authority_or_court_decision', 'parties_agreement')
     OR p_kind = 'requested' AND p_code NOT IN ('evidence_unclear', 'date_unclear',
       'other_documented')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project and participation never change, so they can be read before the locks.
  SELECT * INTO c FROM public.entry_clarification WHERE id = p_clarification_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'clarification_not_found'; END IF;
  PERFORM public.assert_context(p_context, c.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
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
  SELECT * INTO c FROM public.entry_clarification WHERE id = p_clarification_id FOR UPDATE;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  IF r.status::text <> 'informed' THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
  IF c.stage = 'instructed' THEN RAISE EXCEPTION 'already_instructed'; END IF;
  IF c.stage <> 'escalated' THEN RAISE EXCEPTION 'not_escalated'; END IF;
  IF c.escalated_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'same_person_instruction'; END IF;
  IF p_kind = 'instructed' THEN
    UPDATE public.entry_clarification SET stage = 'instructed', instruction_code = p_code,
      instruction_source = v_source, instruction_at = pg_catalog.now(),
      instruction_by = (p_context).staff_user_id, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  ELSE
    -- Back to the PL: the escalation is withdrawn from the row (its step stays in the history).
    UPDATE public.entry_clarification SET stage = 'returned', escalated_at = NULL,
      escalated_by = NULL, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  END IF;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, p_kind, p_code, v_source,
    (p_context).staff_user_id);
  IF p_kind = 'instructed' THEN
    PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_instructed',
      p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('clarificationId', c.id, 'instructionCode', p_code), false);
  ELSE
    PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_requested',
      p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('clarificationId', c.id, 'requestCode', p_code), false);
  END IF;
  RETURN c.id;
END $function$;

ALTER FUNCTION public.answer_entry_clarification(public.audit_context,uuid,text,text,text,integer,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.answer_entry_clarification(public.audit_context,uuid,text,text,text,integer,integer) FROM PUBLIC;
