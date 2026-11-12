CREATE OR REPLACE FUNCTION public.activate_project(p_id uuid, p_base_defaults_version integer, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.project;
  v_version integer;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_base_defaults_version < 1, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'project_not_draft';
  END IF;
  SELECT version INTO v_version FROM public.project_template_pin
  WHERE project_id = p_id AND agentur_key = r.project_agentur_key ORDER BY seq DESC LIMIT 1;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'project_activation_blocked';
  END IF;
  IF r.type = 'ta_tg' AND NOT EXISTS (
    SELECT FROM public.project_entry_wave WHERE project_id = p_id AND latest_entry_date IS NOT NULL) THEN
    RAISE EXCEPTION 'no_entry_wave_with_latest_entry_date';
  END IF;
  UPDATE public.project
  SET status = 'active', activated_at = pg_catalog.now(), activated_by = (p_context).staff_user_id
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_activated', p_context, NULL, NULL, NULL, NULL,
    NULL, pg_catalog.jsonb_build_object('projectAgenturKey', r.project_agentur_key,
      'projectAgenturVersion', v_version, 'baseDefaultsVersion', p_base_defaults_version), false);
END $function$;

ALTER FUNCTION public.activate_project(uuid,integer,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.activate_project(uuid,integer,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_project(uuid,integer,public.audit_context) TO transfer_app;
