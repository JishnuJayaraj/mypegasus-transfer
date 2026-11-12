CREATE OR REPLACE FUNCTION public.record_agentur_rejection(p_context public.audit_context, p_submission_id uuid, p_rejected_on date, p_reason public.agentur_rejection_reason)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.agentur_submission;
BEGIN
  IF p_submission_id IS NULL OR p_rejected_on IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_agentur_submission(p_context, p_submission_id);
  IF s.form_code::text <> 'tl407' THEN
    RAISE EXCEPTION 'rejection_not_applicable';
  END IF;
  IF s.rejected_on IS NOT NULL THEN
    RAISE EXCEPTION 'already_rejected';
  END IF;
  IF p_rejected_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_rejected_on < s.submitted_on THEN
    RAISE EXCEPTION 'date_before_submission';
  END IF;
  UPDATE public.agentur_submission SET rejected_on = p_rejected_on, rejection_reason = p_reason,
    rejection_recorded_by = (p_context).staff_user_id, rejection_recorded_at = now()
  WHERE id = s.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id,
    'agentur_submission_rejected', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('submissionId', s.id,
      'rejectedOn', pg_catalog.to_char(p_rejected_on, 'YYYY-MM-DD'), 'reason', p_reason), false);
END $function$;

ALTER FUNCTION public.record_agentur_rejection(public.audit_context,uuid,date,public.agentur_rejection_reason) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_agentur_rejection(public.audit_context,uuid,date,public.agentur_rejection_reason) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agentur_rejection(public.audit_context,uuid,date,public.agentur_rejection_reason) TO transfer_app;
