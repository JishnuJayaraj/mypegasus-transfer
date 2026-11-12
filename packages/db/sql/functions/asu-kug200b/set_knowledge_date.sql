CREATE OR REPLACE FUNCTION public.set_knowledge_date(p_context public.audit_context, p_participation_id uuid, p_knowledge_date date, p_previous date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_current date;
BEGIN
  IF p_participation_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  SELECT knowledge_date INTO v_current FROM public.participant_details
  WHERE participation_id = r.id FOR UPDATE;
  IF v_current IS DISTINCT FROM p_previous THEN
    RAISE EXCEPTION 'stale_value';
  END IF;
  IF p_knowledge_date > public.berlin_today() THEN
    RAISE EXCEPTION 'knowledge_date_in_future';
  END IF;
  IF v_current IS NOT DISTINCT FROM p_knowledge_date THEN
    RETURN;
  END IF;
  INSERT INTO public.participant_details (participation_id, project_id, knowledge_date)
  VALUES (r.id, r.project_id, p_knowledge_date)
  ON CONFLICT (participation_id) DO UPDATE SET knowledge_date = EXCLUDED.knowledge_date,
    updated_at = now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'knowledge_date_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('change', CASE
      WHEN p_knowledge_date IS NULL THEN 'cleared'
      WHEN v_current IS NULL THEN 'set'
      ELSE 'changed' END), false);
END $function$;

ALTER FUNCTION public.set_knowledge_date(public.audit_context,uuid,date,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_knowledge_date(public.audit_context,uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_knowledge_date(public.audit_context,uuid,date,date) TO transfer_app;
