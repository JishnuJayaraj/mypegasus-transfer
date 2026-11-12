CREATE OR REPLACE FUNCTION public.decide_profiling_exception(p_request_id uuid, p_approve boolean, p_decided_on date, p_evidence_record_id uuid, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_request public.profiling_exception_request;
  v_project_id uuid;
  v_document_ids uuid[];
  r public.participation;
BEGIN
  IF p_approve IS NULL OR p_decided_on IS NULL OR p_evidence_record_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.profiling_exception_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project_id));
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.evidence_record_id <> p_evidence_record_id THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'not_requested';
  END IF;
  IF v_request.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  SELECT document_ids INTO v_document_ids FROM public.profiling_exception_evidence_record
  WHERE id = p_evidence_record_id;
  PERFORM FROM public.document WHERE id = ANY (v_document_ids) ORDER BY id FOR SHARE;
  IF p_approve AND NOT public.exception_evidence_usable(p_evidence_record_id) THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  UPDATE public.profiling_exception_request SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.profiling_exception_status,
    decided_by = (p_context).staff_user_id,
    decided_on = p_decided_on,
    decided_at = now()
  WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id,
    CASE WHEN p_approve THEN 'profiling_exception_approved' ELSE 'profiling_exception_rejected' END::public.audit_event_type,
    p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $function$;

ALTER FUNCTION public.decide_profiling_exception(uuid,boolean,date,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.decide_profiling_exception(uuid,boolean,date,uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_profiling_exception(uuid,boolean,date,uuid,public.audit_context) TO transfer_app;
