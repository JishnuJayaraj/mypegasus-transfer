CREATE OR REPLACE FUNCTION public.decide_rule_relaxation(p_request_id uuid, p_approve boolean, p_decided_on date, p_context public.audit_context, p_expected_version integer DEFAULT NULL::integer, p_content jsonb DEFAULT NULL::jsonb, p_base_defaults_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_request public.config_relaxation_request;
  v_version integer;
BEGIN
  v_request := public.lock_relaxation_request(p_request_id, p_context);
  IF p_approve IS NULL OR p_decided_on IS NULL
     OR NOT p_approve AND (p_expected_version, p_content, p_base_defaults_version) IS DISTINCT FROM
       (NULL::integer, NULL::jsonb, NULL::integer) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF v_request.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  UPDATE public.config_relaxation_request SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.relaxation_request_status,
    decided_by = (p_context).staff_user_id, decided_on = p_decided_on, decided_at = pg_catalog.now()
  WHERE id = p_request_id;
  IF NOT p_approve THEN
    RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_rejected', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', p_request_id,
        'ruleId', v_request.rule_id), false);
  END IF;
  v_version := public.append_project_override(v_request.project_id, p_expected_version, p_content,
    'relaxation_added', NULL, p_base_defaults_version, p_context, v_request.rule_id,
    pg_catalog.jsonb_build_object('ruleId', v_request.rule_id,
      'reasonCode', v_request.reason_code::text,
      'approvedBy', ((p_context).staff_user_id)::text, 'approvedOn', p_decided_on));
  RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_approved', p_context,
    NULL, NULL, NULL, v_request.reason_code::text, NULL, pg_catalog.jsonb_build_object(
      'relaxationRequestId', p_request_id, 'ruleId', v_request.rule_id, 'version', v_version,
      'baseDefaultsVersion', p_base_defaults_version), false);
END $function$;

ALTER FUNCTION public.decide_rule_relaxation(uuid,boolean,date,public.audit_context,integer,jsonb,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.decide_rule_relaxation(uuid,boolean,date,public.audit_context,integer,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_rule_relaxation(uuid,boolean,date,public.audit_context,integer,jsonb,integer) TO transfer_app;
