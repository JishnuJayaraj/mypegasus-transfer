CREATE OR REPLACE FUNCTION public.revoke_profiling_exception(p_request_id uuid, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_request public.profiling_exception_request;
  r public.participation;
BEGIN
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.status NOT IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'not_revocable';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg'
     OR r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'no_longer_applicable';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  UPDATE public.profiling_exception_request SET status = 'revoked' WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id, 'profiling_exception_revoked', p_context, NULL,
    NULL, NULL, NULL, NULL, jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $function$;

ALTER FUNCTION public.revoke_profiling_exception(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.revoke_profiling_exception(uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_profiling_exception(uuid,public.audit_context) TO transfer_app;
