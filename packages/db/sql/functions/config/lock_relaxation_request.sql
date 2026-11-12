CREATE OR REPLACE FUNCTION public.lock_relaxation_request(p_request_id uuid, p_context public.audit_context)
 RETURNS public.config_relaxation_request
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project_id uuid;
  v_request public.config_relaxation_request;
BEGIN
  SELECT project_id INTO v_project_id FROM public.config_relaxation_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO v_request FROM public.config_relaxation_request WHERE id = p_request_id FOR UPDATE;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'relaxation_not_open';
  END IF;
  RETURN v_request;
END $function$;

ALTER FUNCTION public.lock_relaxation_request(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_relaxation_request(uuid,public.audit_context) FROM PUBLIC;
