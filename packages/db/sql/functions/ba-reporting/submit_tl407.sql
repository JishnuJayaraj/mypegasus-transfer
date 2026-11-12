CREATE OR REPLACE FUNCTION public.submit_tl407(p_context public.audit_context, p_participation_id uuid, p_submission_id uuid, p_document_id uuid, p_submitted_on date, p_agentur_key text, p_channel public.agentur_submission_channel, p_original_required boolean, p_outdated_versions text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  d public.document;
  v_last_rejection date;
BEGIN
  IF p_participation_id IS NULL OR p_submission_id IS NULL OR p_document_id IS NULL
     OR p_submitted_on IS NULL OR (p_channel IS NULL) <> (p_original_required IS NULL)
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO d FROM public.document
  WHERE id = p_document_id AND participation_id = r.id AND type = 'tl407_signed_scan'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF r.placement_agentur_key IS NULL THEN
    RAISE EXCEPTION 'placement_agentur_missing';
  END IF;
  IF p_agentur_key IS DISTINCT FROM r.placement_agentur_key THEN
    RAISE EXCEPTION 'settings_changed';
  END IF;
  IF p_channel IS NULL THEN
    RAISE EXCEPTION 'submission_settings_missing';
  END IF;
  IF d.deleted_at IS NOT NULL OR d.review_state <> 'accepted' OR d.quarantined_at IS NOT NULL
     OR d.invalidated_by_correction IS NOT NULL OR d.form_version IS NULL THEN
    RAISE EXCEPTION 'scan_unusable';
  END IF;
  PERFORM FROM public.agentur_submission WHERE participation_id = r.id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT FROM public.agentur_submission
             WHERE participation_id = r.id AND form_code = 'tl407' AND rejected_on IS NULL) THEN
    RAISE EXCEPTION 'already_submitted';
  END IF;
  IF d.form_version = ANY (p_outdated_versions) THEN
    RAISE EXCEPTION 'form_version_outdated';
  END IF;
  IF p_submitted_on > public.berlin_today() THEN
    RAISE EXCEPTION 'submitted_on_in_future';
  END IF;
  IF p_submitted_on < greatest(d.signed_on, d.countersigned_on) THEN
    RAISE EXCEPTION 'submitted_before_signature';
  END IF;
  v_last_rejection := (SELECT pg_catalog.max(rejected_on) FROM public.agentur_submission
                       WHERE participation_id = r.id AND form_code = 'tl407');
  IF p_submitted_on < v_last_rejection THEN
    RAISE EXCEPTION 'submitted_before_rejection';
  END IF;
  INSERT INTO public.agentur_submission (id, project_id, participation_id, document_id, form_code,
    form_version, agentur_key, channel, submitted_on, recorded_by, original_required)
  VALUES (p_submission_id, r.project_id, r.id, d.id, 'tl407', d.form_version, p_agentur_key,
    p_channel, p_submitted_on, (p_context).staff_user_id, p_original_required);
  PERFORM public.write_audit_event(r.project_id, r.id, 'agentur_submission_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('submissionId', p_submission_id,
      'documentId', d.id, 'formCode', 'tl407', 'formVersion', d.form_version,
      'channel', p_channel, 'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD')),
    false);
  RETURN p_submission_id;
END $function$;

ALTER FUNCTION public.submit_tl407(public.audit_context,uuid,uuid,uuid,date,text,public.agentur_submission_channel,boolean,text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.submit_tl407(public.audit_context,uuid,uuid,uuid,date,text,public.agentur_submission_channel,boolean,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_tl407(public.audit_context,uuid,uuid,uuid,date,text,public.agentur_submission_channel,boolean,text[]) TO transfer_app;
