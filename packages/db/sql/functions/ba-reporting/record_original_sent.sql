CREATE OR REPLACE FUNCTION public.record_original_sent(p_context public.audit_context, p_submission_id uuid, p_original_sent_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.agentur_submission;
BEGIN
  IF p_submission_id IS NULL OR p_original_sent_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_agentur_submission(p_context, p_submission_id);
  IF s.form_code::text <> 'tl407' OR NOT s.original_required
     OR s.channel::text = 'paper_original' THEN
    RAISE EXCEPTION 'original_not_required';
  END IF;
  IF s.original_sent_on IS NOT NULL THEN
    RAISE EXCEPTION 'original_recorded';
  END IF;
  IF p_original_sent_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_original_sent_on < s.submitted_on THEN
    RAISE EXCEPTION 'date_before_submission';
  END IF;
  UPDATE public.agentur_submission SET original_sent_on = p_original_sent_on,
    original_recorded_by = (p_context).staff_user_id, original_recorded_at = now()
  WHERE id = s.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id,
    'agentur_submission_original_sent', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('submissionId', s.id,
      'originalSentOn', pg_catalog.to_char(p_original_sent_on, 'YYYY-MM-DD')), false);
END $function$;

ALTER FUNCTION public.record_original_sent(public.audit_context,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_original_sent(public.audit_context,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_original_sent(public.audit_context,uuid,date) TO transfer_app;
