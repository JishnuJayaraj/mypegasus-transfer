CREATE OR REPLACE FUNCTION public.update_entry_wave(p_project_id uuid, p_id uuid, p_code text, p_name text, p_signing_deadline date, p_default_tg_start date, p_default_tg_end date, p_latest_entry_date date, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.project_entry_wave;
  v_type public.project_type;
  v_fields text[];
  v_dates jsonb;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project_entry_wave WHERE id = p_id AND project_id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wave_not_found';
  END IF;
  -- Defended here too, not only by the service (round 24).
  SELECT type INTO v_type FROM public.project WHERE id = p_project_id;
  IF v_type <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT public.entry_wave_text_valid(p_code, p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}'),
    pg_catalog.jsonb_object_agg(c.field, pg_catalog.jsonb_build_object('from', c.old, 'to', c.new))
      FILTER (WHERE c.ord > 2)
  INTO v_fields, v_dates
  FROM (VALUES (1, 'code', pg_catalog.to_jsonb(r.code), pg_catalog.to_jsonb(p_code)),
    (2, 'name', pg_catalog.to_jsonb(r.name), pg_catalog.to_jsonb(p_name)),
    (3, 'signingDeadline', pg_catalog.to_jsonb(r.signing_deadline), pg_catalog.to_jsonb(p_signing_deadline)),
    (4, 'defaultTgStart', pg_catalog.to_jsonb(r.default_tg_start), pg_catalog.to_jsonb(p_default_tg_start)),
    (5, 'defaultTgEnd', pg_catalog.to_jsonb(r.default_tg_end), pg_catalog.to_jsonb(p_default_tg_end)),
    (6, 'latestEntryDate', pg_catalog.to_jsonb(r.latest_entry_date), pg_catalog.to_jsonb(p_latest_entry_date))
  ) AS c(ord, field, old, new)
  WHERE c.old IS DISTINCT FROM c.new;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'wave_unchanged';
  END IF;
  UPDATE public.project_entry_wave
  SET code = p_code, name = p_name, signing_deadline = p_signing_deadline,
      default_tg_start = p_default_tg_start, default_tg_end = p_default_tg_end,
      latest_entry_date = p_latest_entry_date, updated_at = pg_catalog.now()
  WHERE id = p_id;
  RETURN public.write_audit_event(p_project_id, NULL, 'entry_wave_changed', p_context, NULL, NULL, NULL,
    NULL, NULL, pg_catalog.jsonb_build_object('waveId', p_id, 'fields', pg_catalog.to_jsonb(v_fields))
      || CASE WHEN v_dates IS NULL THEN '{}' ELSE pg_catalog.jsonb_build_object('dates', v_dates) END,
    false);
END $function$;

ALTER FUNCTION public.update_entry_wave(uuid,uuid,text,text,date,date,date,date,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.update_entry_wave(uuid,uuid,text,text,date,date,date,date,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_entry_wave(uuid,uuid,text,text,date,date,date,date,public.audit_context) TO transfer_app;
