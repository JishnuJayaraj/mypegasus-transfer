CREATE OR REPLACE FUNCTION public.record_entry_clarification(p_context public.audit_context, p_participation_id uuid, p_code text, p_source text, p_status_version integer, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  c public.entry_clarification;
  v_source text := public.normalise_correction_source(p_source);
  v_opened date;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_code IS NULL OR p_code NOT IN ('awaiting_countersignature', 'awaiting_asu_proof',
       'awaiting_profiling', 'awaiting_legal_advice')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  IF r.status::text <> 'informed' THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
  SELECT * INTO c FROM public.entry_clarification
  WHERE participation_id = r.id AND stage <> 'instructed' FOR UPDATE;
  IF FOUND THEN
    IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
    IF c.stage = 'escalated' THEN RAISE EXCEPTION 'clarification_escalated'; END IF;
    UPDATE public.entry_clarification SET stage = 'documented', pending_code = p_code,
      pending_source = v_source, pending_recorded_at = pg_catalog.now(),
      pending_recorded_by = (p_context).staff_user_id, revision = c.revision + 1
    WHERE id = c.id RETURNING * INTO c;
  ELSE
    v_opened := public.entry_clarification_opened_on(r.id);
    IF v_opened IS NULL THEN RAISE EXCEPTION 'clarification_not_open'; END IF;
    IF EXISTS (SELECT FROM public.entry_clarification
               WHERE participation_id = r.id AND opened_on = v_opened) THEN
      RAISE EXCEPTION 'already_instructed';
    END IF;
    IF p_expected_revision <> 0 THEN RAISE EXCEPTION 'stale_clarification'; END IF;
    INSERT INTO public.entry_clarification (project_id, participation_id, opened_on, stage,
      revision, pending_code, pending_source, pending_recorded_at, pending_recorded_by)
    VALUES (r.project_id, r.id, v_opened, 'documented', 1, p_code, v_source, pg_catalog.now(),
      (p_context).staff_user_id)
    RETURNING * INTO c;
  END IF;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, 'recorded', p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', p_code), false);
  RETURN c.id;
END $function$;

ALTER FUNCTION public.record_entry_clarification(public.audit_context,uuid,text,text,integer,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_entry_clarification(public.audit_context,uuid,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_entry_clarification(public.audit_context,uuid,text,text,integer,integer) TO transfer_app;
