CREATE OR REPLACE FUNCTION public.request_profiling_exception(p_id uuid, p_reason public.profiling_exception_reason, p_requested_on date, p_evidence_record_id uuid, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_latest public.profiling_exception_request;
  v_record public.profiling_exception_evidence_record;
  v_request_id uuid;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_reason IS NULL OR p_requested_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  SELECT * INTO v_latest FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  IF r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'profiling_closed';
  END IF;
  IF v_latest.status IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'exception_open';
  END IF;
  SELECT * INTO v_record FROM public.profiling_exception_evidence_record
  WHERE id = p_evidence_record_id AND participation_id = p_id;
  IF v_record.id IS NULL THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  -- The record's documents in id order, held while the request is written.
  PERFORM FROM public.document WHERE id = ANY (v_record.document_ids) ORDER BY id FOR SHARE;
  IF NOT public.exception_evidence_usable(v_record.id) THEN
    RAISE EXCEPTION 'evidence_missing';
  END IF;
  IF v_record.fingerprint = v_latest.evidence_fingerprint THEN
    RAISE EXCEPTION 'evidence_unchanged';
  END IF;
  IF p_reason = 'ba_confirmed_other' AND v_record.kind::text <> 'ba_confirmation' THEN
    RAISE EXCEPTION 'ba_confirmation_missing';
  END IF;
  INSERT INTO public.profiling_exception_request (
    project_id, participation_id, reason_code, status, requested_by, requested_on,
    evidence_record_id, evidence_fingerprint
  ) VALUES (
    r.project_id, p_id, p_reason, 'requested', (p_context).staff_user_id, p_requested_on,
    v_record.id, v_record.fingerprint
  ) RETURNING id INTO v_request_id;
  UPDATE public.participation
  SET profiling_exception_request_id = v_request_id, status_version = status_version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_requested', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    -- The opaque evidence record id only; the fingerprint stays on the request (round 17).
    jsonb_build_object('profilingExceptionRequestId', v_request_id,
      'evidenceRecordId', v_record.id), false);
  RETURN v_request_id;
END $function$;

ALTER FUNCTION public.request_profiling_exception(uuid,public.profiling_exception_reason,date,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_profiling_exception(uuid,public.profiling_exception_reason,date,uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_profiling_exception(uuid,public.profiling_exception_reason,date,uuid,public.audit_context) TO transfer_app;
