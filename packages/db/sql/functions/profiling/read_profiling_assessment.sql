CREATE OR REPLACE FUNCTION public.read_profiling_assessment(p_participation_id uuid, p_context public.audit_context, p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project_id uuid;
  v_old jsonb;
  v_field text;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT public.profiler_may_read(p_participation_id, p_context) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_old := public.open_profiling_assessment(p_participation_id, p_key, p_key_id);
  FOR v_field IN SELECT f FROM pg_catalog.jsonb_object_keys(v_old -> 'fields') f ORDER BY f LOOP
    PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read',
      p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', v_field),
      false);
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('revision', v_old -> 'revision',
    'values', public.profiling_assessment_values(v_old -> 'fields'));
END $function$;

ALTER FUNCTION public.read_profiling_assessment(uuid,public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.read_profiling_assessment(uuid,public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_profiling_assessment(uuid,public.audit_context,text,text) TO transfer_app;
