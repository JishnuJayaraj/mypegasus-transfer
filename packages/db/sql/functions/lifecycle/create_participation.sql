CREATE OR REPLACE FUNCTION public.create_participation(p_project_id uuid, p_context public.audit_context, p_entry_wave_id uuid DEFAULT NULL::uuid, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_type public.project_type;
BEGIN
  PERFORM public.assert_context(p_context, v_id, (
    SELECT actors FROM public.lifecycle_edge
    WHERE track = 'main' AND from_value IS NULL AND to_value = 'imported' AND kind = 'manual'));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.project_lock_key(p_project_id));
  SELECT type INTO v_type FROM public.project WHERE id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF p_entry_wave_id IS NOT NULL THEN
    IF v_type <> 'ta_tg' THEN
      RAISE EXCEPTION 'not_ta_tg';
    END IF;
    IF NOT EXISTS (SELECT FROM public.project_entry_wave WHERE id = p_entry_wave_id AND project_id = p_project_id) THEN
      RAISE EXCEPTION 'wave_of_other_project';
    END IF;
  END IF;
  INSERT INTO public.participation (id, project_id, entry_wave_id, status, profiling_status, dsv_status)
  VALUES (v_id, p_project_id, p_entry_wave_id, 'imported', 'not_started', 'not_offered');
  PERFORM public.write_audit_event(p_project_id, v_id, 'participation_created', p_context, 'status', NULL,
    'imported', NULL, NULL, jsonb_strip_nulls(jsonb_build_object('entryWaveId', p_entry_wave_id)), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.create_participation(uuid,public.audit_context,uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_participation(uuid,public.audit_context,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_participation(uuid,public.audit_context,uuid,uuid) TO transfer_app;
