CREATE OR REPLACE FUNCTION public.lock_current_request(p_request_id uuid, p_context public.audit_context)
 RETURNS public.profiling_exception_request
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation_id uuid;
  v_request public.profiling_exception_request;
BEGIN
  SELECT participation_id INTO v_participation_id FROM public.profiling_exception_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (public.lock_participation(v_participation_id)).profiling_exception_request_id IS DISTINCT FROM p_request_id THEN
    RAISE EXCEPTION 'request_not_current';
  END IF;
  SELECT * INTO v_request FROM public.profiling_exception_request WHERE id = p_request_id;
  RETURN v_request;
END $function$;

ALTER FUNCTION public.lock_current_request(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_current_request(uuid,public.audit_context) FROM PUBLIC;
