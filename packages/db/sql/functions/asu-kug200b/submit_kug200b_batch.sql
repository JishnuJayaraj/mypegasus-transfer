CREATE OR REPLACE FUNCTION public.submit_kug200b_batch(p_context public.audit_context, p_batch_id uuid, p_submitted_on date, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
  m public.kug200b_batch_member;
  v_rows jsonb;
  v_submission_id uuid;
  v_registration_id uuid;
  v_registrations integer := 0;
BEGIN
  IF p_batch_id IS NULL OR p_submitted_on IS NULL OR p_artifact IS NULL
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  IF p_submitted_on > public.berlin_today() THEN
    RAISE EXCEPTION 'submitted_on_in_future';
  END IF;
  IF p_submitted_on < (b.created_at AT TIME ZONE 'Europe/Berlin')::date THEN
    RAISE EXCEPTION 'submitted_before_batch';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  PERFORM FROM public.kug200b_batch WHERE id = b.id FOR UPDATE;
  UPDATE public.kug200b_batch SET status = 'submitted', submitted_on = p_submitted_on,
    submitted_by = (p_context).staff_user_id, submitted_at = now()
  WHERE id = b.id;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id
           ORDER BY participation_id LOOP
    v_submission_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.agentur_submission (id, project_id, participation_id, document_id,
      form_code, form_version, agentur_key, channel, batch_id, submitted_on, recorded_by)
    VALUES (v_submission_id, b.project_id, m.participation_id, m.document_id, 'kug200b',
      m.form_version, b.agentur_key, b.channel::text::public.agentur_submission_channel, b.id,
      p_submitted_on, (p_context).staff_user_id);
    PERFORM public.write_audit_event(b.project_id, m.participation_id,
      'agentur_submission_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('submissionId', v_submission_id, 'documentId', m.document_id,
        'formCode', 'kug200b', 'formVersion', m.form_version, 'channel', b.channel,
        'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'), 'batchId', b.id), false);
    IF m.asu_channel = 'kug_200b' THEN
      v_registration_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.asu_registration (id, project_id, participation_id, channel,
        registered_on, recorded_by, proof_kind, proof_linked_by, proof_linked_at,
        agentur_submission_id)
      VALUES (v_registration_id, b.project_id, m.participation_id, 'kug_200b', p_submitted_on,
        (p_context).staff_user_id, 'kug200b_submission', (p_context).staff_user_id, now(),
        v_submission_id);
      PERFORM public.write_audit_event(b.project_id, m.participation_id,
        'asu_registration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('registrationId', v_registration_id,
          'channel', 'kug_200b', 'registeredOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'),
          'proofKind', 'kug200b_submission'), false);
      v_registrations := v_registrations + 1;
    END IF;
  END LOOP;
  PERFORM public.write_audit_event(b.project_id, NULL, 'kug200b_batch_submitted', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', b.id,
      'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'),
      'count', b.member_count, 'registrations', v_registrations), false);
  RETURN pg_catalog.jsonb_build_object('submissions', b.member_count,
    'registrations', v_registrations);
END $function$;

ALTER FUNCTION public.submit_kug200b_batch(public.audit_context,uuid,date,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.submit_kug200b_batch(public.audit_context,uuid,date,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_kug200b_batch(public.audit_context,uuid,date,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) TO transfer_app;
