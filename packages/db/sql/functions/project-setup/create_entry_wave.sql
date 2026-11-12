CREATE OR REPLACE FUNCTION public.create_entry_wave(p_project_id uuid, p_code text, p_name text, p_context public.audit_context, p_signing_deadline date DEFAULT NULL::date, p_default_tg_start date DEFAULT NULL::date, p_default_tg_end date DEFAULT NULL::date, p_latest_entry_date date DEFAULT NULL::date, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := coalesce(p_id, pg_catalog.gen_random_uuid());
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT public.entry_wave_text_valid(p_code, p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.project_entry_wave (id, project_id, code, name, signing_deadline, default_tg_start,
    default_tg_end, latest_entry_date)
  VALUES (v_id, p_project_id, p_code, p_name, p_signing_deadline, p_default_tg_start, p_default_tg_end,
    p_latest_entry_date);
  PERFORM public.write_audit_event(p_project_id, NULL, 'entry_wave_created', p_context, NULL, NULL, NULL,
    NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('waveId', v_id,
      'signingDeadline', p_signing_deadline,
      'defaultTgStart', p_default_tg_start, 'defaultTgEnd', p_default_tg_end,
      'latestEntryDate', p_latest_entry_date)), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.create_entry_wave(uuid,text,text,public.audit_context,date,date,date,date,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_entry_wave(uuid,text,text,public.audit_context,date,date,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_entry_wave(uuid,text,text,public.audit_context,date,date,date,date,uuid) TO transfer_app;
