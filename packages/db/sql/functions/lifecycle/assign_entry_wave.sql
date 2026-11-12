CREATE OR REPLACE FUNCTION public.assign_entry_wave(p_id uuid, p_wave_id uuid, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  r := public.lock_participation(p_id);
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF r.status NOT IN ('imported', 'contacted', 'unreachable', 'informed') THEN
    RAISE EXCEPTION 'status_not_open';
  END IF;
  IF r.dsv_status <> 'not_offered' THEN
    RAISE EXCEPTION 'dsv_already_offered';
  END IF;
  IF r.tg_start IS NOT NULL OR r.tg_end IS NOT NULL THEN
    RAISE EXCEPTION 'individual_dates_set';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_entry_wave WHERE id = p_wave_id AND project_id = r.project_id) THEN
    RAISE EXCEPTION 'wave_of_other_project';
  END IF;
  -- Assigning the current wave again is a no-op, refused without a write (round 16).
  IF r.entry_wave_id = p_wave_id THEN
    RAISE EXCEPTION 'wave_unchanged';
  END IF;
  UPDATE public.participation SET entry_wave_id = p_wave_id, status_version = status_version + 1 WHERE id = p_id;
  RETURN public.write_audit_event(r.project_id, p_id, 'entry_wave_assigned', p_context, NULL, NULL, NULL,
    NULL, NULL, jsonb_build_object('waveId', p_wave_id, 'previousWaveId', r.entry_wave_id), false);
END $function$;

ALTER FUNCTION public.assign_entry_wave(uuid,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assign_entry_wave(uuid,uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_entry_wave(uuid,uuid,public.audit_context) TO transfer_app;
