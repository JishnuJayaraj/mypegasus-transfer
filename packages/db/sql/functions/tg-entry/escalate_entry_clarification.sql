CREATE OR REPLACE FUNCTION public.escalate_entry_clarification(p_context public.audit_context, p_participation_id uuid, p_status_version integer, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  c public.entry_clarification;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
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
  IF NOT FOUND THEN RAISE EXCEPTION 'clarification_not_documented'; END IF;
  IF c.revision <> p_expected_revision THEN RAISE EXCEPTION 'stale_clarification'; END IF;
  IF c.stage = 'escalated' THEN RAISE EXCEPTION 'already_escalated'; END IF;
  IF c.stage <> 'documented' THEN RAISE EXCEPTION 'clarification_not_documented'; END IF;
  UPDATE public.entry_clarification SET stage = 'escalated', escalated_at = pg_catalog.now(),
    escalated_by = (p_context).staff_user_id, revision = c.revision + 1
  WHERE id = c.id RETURNING * INTO c;
  INSERT INTO public.entry_clarification_step (project_id, participation_id, clarification_id, seq,
    kind, code, source, by)
  VALUES (r.project_id, r.id, c.id, c.revision, 'escalated', c.pending_code, c.pending_source,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'entry_clarification_escalated', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('clarificationId', c.id, 'pendingCode', c.pending_code), false);
  RETURN c.id;
END $function$;

ALTER FUNCTION public.escalate_entry_clarification(public.audit_context,uuid,integer,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.escalate_entry_clarification(public.audit_context,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.escalate_entry_clarification(public.audit_context,uuid,integer,integer) TO transfer_app;
