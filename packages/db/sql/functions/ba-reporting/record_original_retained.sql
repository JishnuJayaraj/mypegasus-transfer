CREATE OR REPLACE FUNCTION public.record_original_retained(p_context public.audit_context, p_submission_id uuid, p_retained_from uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.agentur_submission;
  e public.agentur_submission;
BEGIN
  IF p_submission_id IS NULL OR p_retained_from IS NULL THEN
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
  SELECT * INTO e FROM public.agentur_submission
  WHERE id = p_retained_from AND participation_id = s.participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retained_original_not_found';
  END IF;
  IF e.id = s.id OR e.form_code::text <> 'tl407' OR e.document_id <> s.document_id
     OR e.agentur_key <> s.agentur_key OR e.rejected_on IS NULL OR e.original_sent_on IS NULL
     OR e.recorded_at >= s.recorded_at THEN
    RAISE EXCEPTION 'original_not_retainable';
  END IF;
  UPDATE public.agentur_submission SET original_sent_on = e.original_sent_on,
    original_retained_from = e.id, original_recorded_by = (p_context).staff_user_id,
    original_recorded_at = now()
  WHERE id = s.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id,
    'agentur_submission_original_retained', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('submissionId', s.id, 'retainedFrom', e.id,
      'originalSentOn', pg_catalog.to_char(e.original_sent_on, 'YYYY-MM-DD')), false);
END $function$;

ALTER FUNCTION public.record_original_retained(public.audit_context,uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_original_retained(public.audit_context,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_original_retained(public.audit_context,uuid,uuid) TO transfer_app;
