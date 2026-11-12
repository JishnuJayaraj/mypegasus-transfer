CREATE OR REPLACE FUNCTION public.request_rule_relaxation(p_project_id uuid, p_rule_id text, p_reason_code public.relaxation_reason_code, p_requested_on date, p_base_defaults_version integer, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_rule_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' OR p_reason_code IS NULL
      OR p_requested_on IS NULL OR p_base_defaults_version < 1, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF EXISTS (SELECT FROM public.config_relaxation_request
      WHERE project_id = p_project_id AND rule_id = p_rule_id AND status = 'requested') THEN
    RAISE EXCEPTION 'relaxation_request_open';
  END IF;
  IF EXISTS (SELECT FROM public.override_relaxations_of((SELECT content
      FROM public.project_config_override WHERE project_id = p_project_id
      ORDER BY version DESC LIMIT 1), p_rule_id)) THEN
    RAISE EXCEPTION 'relaxation_exists';
  END IF;
  INSERT INTO public.config_relaxation_request (project_id, rule_id, reason_code, status,
    requested_by, requested_on)
  VALUES (p_project_id, p_rule_id, p_reason_code, 'requested', (p_context).staff_user_id,
    p_requested_on)
  RETURNING id INTO v_id;
  PERFORM public.write_audit_event(p_project_id, NULL, 'rule_relaxation_requested', p_context, NULL,
    NULL, NULL, p_reason_code::text, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', v_id,
      'ruleId', p_rule_id, 'baseDefaultsVersion', p_base_defaults_version), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.request_rule_relaxation(uuid,text,public.relaxation_reason_code,date,integer,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_rule_relaxation(uuid,text,public.relaxation_reason_code,date,integer,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_rule_relaxation(uuid,text,public.relaxation_reason_code,date,integer,public.audit_context) TO transfer_app;
