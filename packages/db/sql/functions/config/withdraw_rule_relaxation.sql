CREATE OR REPLACE FUNCTION public.withdraw_rule_relaxation(p_request_id uuid, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_request public.config_relaxation_request;
BEGIN
  v_request := public.lock_relaxation_request(p_request_id, p_context);
  UPDATE public.config_relaxation_request SET status = 'withdrawn' WHERE id = p_request_id;
  RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_withdrawn', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', p_request_id,
      'ruleId', v_request.rule_id), false);
END $function$;

ALTER FUNCTION public.withdraw_rule_relaxation(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.withdraw_rule_relaxation(uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdraw_rule_relaxation(uuid,public.audit_context) TO transfer_app;
