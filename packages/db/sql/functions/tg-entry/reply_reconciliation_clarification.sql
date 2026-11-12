CREATE OR REPLACE FUNCTION public.reply_reconciliation_clarification(p_context public.audit_context, p_reconciliation_id uuid, p_code text, p_source text, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tg_entry_reconciliation;
  v_source text := public.normalise_correction_source(p_source);
BEGIN
  IF p_reconciliation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_code IS NULL OR p_code NOT IN ('evidence_supplemented', 'explained',
       'correction_requested')
     OR v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_not_found'; END IF;
  PERFORM public.assert_context(p_context, t.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  PERFORM public.lock_participation(t.participation_id);
  IF NOT public.document_staff_roles(t.participation_id, (p_context).staff_user_id)
     && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.tg_entry_reconciliation WHERE id = p_reconciliation_id FOR UPDATE;
  IF t.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_reconciliation'; END IF;
  IF t.stage <> 'clarification_requested' THEN RAISE EXCEPTION 'not_awaiting'; END IF;
  UPDATE public.tg_entry_reconciliation SET stage = 'replied', revision = t.revision + 1
  WHERE id = t.id RETURNING * INTO t;
  INSERT INTO public.tg_entry_reconciliation_step (project_id, participation_id,
    reconciliation_id, seq, kind, code, source, by)
  VALUES (t.project_id, t.participation_id, t.id, t.revision, 'replied', p_code, v_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'reconciliation_replied',
    p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('reconciliationId', t.id, 'replyCode', p_code), false);
  RETURN t.id;
END $function$;

ALTER FUNCTION public.reply_reconciliation_clarification(public.audit_context,uuid,text,text,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.reply_reconciliation_clarification(public.audit_context,uuid,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reply_reconciliation_clarification(public.audit_context,uuid,text,text,integer) TO transfer_app;
