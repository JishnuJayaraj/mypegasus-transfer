CREATE OR REPLACE FUNCTION public.add_participant_channel(p_token_hash text, p_code_hash text, p_channel_id uuid, p_consent_id uuid, p_consent_version text, p_language public.notice_language, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.participant_session;
  v public.one_time_code_challenge;
  v_result text;
  v_challenge uuid;
  v_context public.audit_context;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_channel_id IS NULL
     OR p_consent_id IS NULL OR p_language IS NULL
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v2' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(s.participation_id,
    'channel_verification', p_code_hash, p_request_id);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  SELECT * INTO v FROM public.one_time_code_challenge WHERE id = v_challenge;
  PERFORM public.assert_channel_available(s.participation_id, v.kind, v.address);
  v_context := public.participant_context(s.participation_id, p_request_id);
  INSERT INTO public.consent_record (
    id, project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
  VALUES (p_consent_id, s.project_id, s.participation_id, 'portal_contact', p_channel_id,
    p_consent_version, p_language, 'participant');
  BEGIN
    INSERT INTO public.participant_channel (
      id, project_id, participation_id, kind, address, verified_by, consent_id)
    VALUES (p_channel_id, s.project_id, s.participation_id, v.kind, v.address, 'one_time_code',
      p_consent_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'channel_in_use';
  END;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_given', v_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', p_channel_id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'contact_channel_added',
    v_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('channelId',
      p_channel_id, 'kind', v.kind, 'verifiedBy', 'one_time_code'), false);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN 'added';
END $function$;

ALTER FUNCTION public.add_participant_channel(text,text,uuid,uuid,text,public.notice_language,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.add_participant_channel(text,text,uuid,uuid,text,public.notice_language,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_participant_channel(text,text,uuid,uuid,text,public.notice_language,text) TO transfer_app;
