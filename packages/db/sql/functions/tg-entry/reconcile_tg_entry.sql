CREATE OR REPLACE FUNCTION public.reconcile_tg_entry(p_context public.audit_context, p_participation_id uuid, p_status_version integer, p_evidence jsonb, p_confirmed boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_tg_start date;
  v_type public.project_type;
  v_packet jsonb;
  v_item jsonb;
  v_kinds text[];
  v_id uuid;
  v_event uuid;
BEGIN
  IF p_participation_id IS NULL OR p_status_version IS NULL OR p_status_version < 0
     OR p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'array'
     OR pg_catalog.jsonb_array_length(p_evidence) <> 3 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_evidence) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR NOT (v_item ?& '{kind,id,validOn,recordedAt}')
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_item)) <> 4
       OR v_item ->> 'kind' NOT IN ('dsv_packet', 'asu_registration', 'tl407', 'profiling_exception')
       OR v_item ->> 'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT public.iso_date_valid(v_item -> 'validOn')
       OR v_item ->> 'recordedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END LOOP;
  v_kinds := ARRAY(SELECT e ->> 'kind' FROM pg_catalog.jsonb_array_elements(p_evidence) e);
  IF NOT v_kinds @> '{dsv_packet,asu_registration}'
     OR NOT (v_kinds && '{tl407,profiling_exception}')
     OR (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.unnest(v_kinds) k) <> 3
     OR v_kinds @> '{tl407,profiling_exception}' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_confirmed IS NOT TRUE THEN RAISE EXCEPTION 'confirmation_required'; END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version <> p_status_version THEN RAISE EXCEPTION 'stale_status_version'; END IF;
  SELECT pj.type, coalesce(r.tg_start, w.default_tg_start) INTO v_type, v_tg_start
  FROM public.project pj LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
  WHERE pj.id = r.project_id;
  IF v_type::text <> 'ta_tg' OR r.status::text <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF v_tg_start IS NULL THEN RAISE EXCEPTION 'tg_start_missing'; END IF;
  -- Never backdated on evidence valid later (Q68): every fact valid on the TG start.
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_evidence) e
             WHERE (e ->> 'validOn')::date > v_tg_start) THEN
    RAISE EXCEPTION 'evidence_after_tg_start';
  END IF;
  SELECT e INTO v_packet FROM pg_catalog.jsonb_array_elements(p_evidence) e
  WHERE e ->> 'kind' = 'dsv_packet';
  IF NOT EXISTS (
    SELECT FROM public.dsv_facts(ARRAY[r.id]) f JOIN public.dsv_offer o ON o.id = f.offer_id
    WHERE o.ended_as = 'signed' AND f.document_id = (v_packet ->> 'id')::uuid
      AND f.executed_on = (v_packet ->> 'validOn')::date) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  PERFORM FROM public.document WHERE id = (v_packet ->> 'id')::uuid FOR SHARE;
  INSERT INTO public.tg_entry_reconciliation (project_id, participation_id, effective_date,
    evidence, confirmed, reconciled_by)
  VALUES (r.project_id, r.id, v_tg_start, p_evidence, true, (p_context).staff_user_id)
  RETURNING id INTO v_id;
  v_event := public.apply_status_change(r.id, 'status', 'informed', 'active_in_tg', p_context,
    p_entry_kind => 'reconciliation', p_effective_date => v_tg_start);
  UPDATE public.tg_entry_reconciliation SET status_event_id = v_event WHERE id = v_id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'tg_entry_reconciled', p_context, NULL,
    NULL, NULL, NULL, v_tg_start,
    pg_catalog.jsonb_build_object('reconciliationId', v_id, 'evidenceKinds',
      pg_catalog.to_jsonb(v_kinds)), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.reconcile_tg_entry(public.audit_context,uuid,integer,jsonb,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.reconcile_tg_entry(public.audit_context,uuid,integer,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_tg_entry(public.audit_context,uuid,integer,jsonb,boolean) TO transfer_app;
