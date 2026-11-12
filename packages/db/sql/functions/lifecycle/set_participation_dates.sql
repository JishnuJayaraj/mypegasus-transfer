CREATE OR REPLACE FUNCTION public.set_participation_dates(p_id uuid, p_tg_start date, p_tg_end date, p_expected_version integer, p_context public.audit_context, p_amendment_kind public.dsv_amendment_kind DEFAULT NULL::public.dsv_amendment_kind, p_amendment_fully_executed_on date DEFAULT NULL::date, p_amendment_original_location public.amendment_original_location DEFAULT NULL::public.amendment_original_location, p_amendment_document_reference text DEFAULT NULL::text, p_amendment_confirmed boolean DEFAULT NULL::boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  w public.project_entry_wave;
  v_old_start date;
  v_new_start date;
  v_old_end date;
  v_new_end date;
  v_start_changed boolean;
  v_end_changed boolean;
  v_kind public.dsv_amendment_kind;
  v_amendment_id uuid;
  v_kinds text[] := '{}';
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_expected_version IS NULL
     OR num_nulls(p_amendment_kind, p_amendment_fully_executed_on, p_amendment_original_location,
       p_amendment_confirmed) NOT IN (0, 4)
     OR p_amendment_confirmed IS FALSE
     OR (p_amendment_kind IS NULL AND p_amendment_document_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- The shared project lock, then the row (D3): a wave edit never interleaves.
  r := public.lock_participation(p_id);
  IF r.status_version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_status';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wave_required';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF r.dsv_status = 'dsv_offered' THEN
    RAISE EXCEPTION 'dsv_offer_open';
  END IF;
  -- An amendment exactly once the DSV is signed (R34, round 33).
  IF r.dsv_status = 'dsv_signed' AND p_amendment_kind IS NULL THEN
    RAISE EXCEPTION 'dsv_amendment_required';
  END IF;
  IF r.dsv_status <> 'dsv_signed' AND p_amendment_kind IS NOT NULL THEN
    RAISE EXCEPTION 'amendment_not_allowed';
  END IF;
  v_old_start := coalesce(r.tg_start, w.default_tg_start);
  v_new_start := coalesce(p_tg_start, w.default_tg_start);
  v_old_end := coalesce(r.tg_end, w.default_tg_end);
  v_new_end := coalesce(p_tg_end, w.default_tg_end);
  v_start_changed := v_old_start IS DISTINCT FROM v_new_start;
  v_end_changed := v_old_end IS DISTINCT FROM v_new_end;
  IF NOT v_start_changed AND NOT v_end_changed THEN
    RAISE EXCEPTION 'dates_unchanged';
  END IF;
  IF v_start_changed AND r.status = 'active_in_tg' THEN
    RAISE EXCEPTION 'entered';
  END IF;
  -- A new start's amendment when the start changes, else an extension's (R41).
  v_kind := CASE WHEN r.dsv_status <> 'dsv_signed' THEN NULL
    WHEN v_start_changed THEN 'new_start' ELSE 'extension' END;
  IF p_amendment_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'amendment_kind_mismatch';
  END IF;

  UPDATE public.participation
  SET tg_start = p_tg_start, tg_end = p_tg_end, status_version = status_version + 1
  WHERE id = p_id;
  IF p_amendment_kind IS NOT NULL THEN
    INSERT INTO public.participation_dsv_amendment (
      participation_id, project_id, kind, fully_executed_on, old_tg_start, new_tg_start, old_tg_end,
      new_tg_end, confirmed_by, original_location, document_reference
    ) VALUES (
      p_id, r.project_id, p_amendment_kind, p_amendment_fully_executed_on, v_old_start, v_new_start,
      v_old_end, v_new_end, (p_context).staff_user_id, p_amendment_original_location,
      p_amendment_document_reference
    ) RETURNING id INTO v_amendment_id;
  END IF;
  IF v_start_changed THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date, amendment_id)
    VALUES (p_id, r.project_id, 'later_entry', v_new_start, v_amendment_id);
    v_kinds := array_append(v_kinds, 'later_entry');
  END IF;
  IF v_end_changed THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date, amendment_id)
    VALUES (p_id, r.project_id, 'planned_end_changed', v_new_end, v_amendment_id);
    v_kinds := array_append(v_kinds, 'planned_end_changed');
  END IF;
  RETURN public.write_audit_event(r.project_id, p_id, 'participation_dates_changed', p_context, NULL,
    NULL, NULL, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'oldTgStart', CASE WHEN v_start_changed THEN v_old_start END,
      'newTgStart', CASE WHEN v_start_changed THEN v_new_start END,
      'oldTgEnd', CASE WHEN v_end_changed THEN v_old_end END,
      'newTgEnd', CASE WHEN v_end_changed THEN v_new_end END,
      'amendmentId', v_amendment_id,
      'reportingKinds', to_jsonb(v_kinds))), false);
END $function$;

ALTER FUNCTION public.set_participation_dates(uuid,date,date,integer,public.audit_context,public.dsv_amendment_kind,date,public.amendment_original_location,text,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_participation_dates(uuid,date,date,integer,public.audit_context,public.dsv_amendment_kind,date,public.amendment_original_location,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_participation_dates(uuid,date,date,integer,public.audit_context,public.dsv_amendment_kind,date,public.amendment_original_location,text,boolean) TO transfer_app;
