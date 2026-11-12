CREATE OR REPLACE FUNCTION public.upgrade_channel_consent(p_token_hash text, p_channel_id uuid, p_consent_id uuid, p_consent_version text, p_language public.notice_language, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.participant_session;
  ch public.participant_channel;
  k public.consent_record;
  v_context public.audit_context;
BEGIN
  IF p_channel_id IS NULL OR p_consent_id IS NULL OR p_language IS NULL
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v2' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
    AND suspended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_not_found';
  END IF;
  SELECT * INTO k FROM public.consent_record WHERE id = ch.consent_id FOR UPDATE;
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  IF k.text_version = p_consent_version AND k.ended_at IS NULL THEN
    RETURN 'already_current';
  END IF;
  v_context := public.participant_context(s.participation_id, p_request_id);
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'superseded'
  WHERE id = k.id AND ended_at IS NULL;
  INSERT INTO public.consent_record (
    id, project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
  VALUES (p_consent_id, s.project_id, s.participation_id, 'portal_contact', ch.id,
    p_consent_version, p_language, 'participant');
  UPDATE public.participant_channel SET consent_id = p_consent_id WHERE id = ch.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_ended', v_context,
    NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object('consentId', k.id,
      'channelId', ch.id, 'purpose', 'portal_contact'), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_given', v_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', ch.id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  RETURN 'upgraded';
END $function$;

ALTER FUNCTION public.upgrade_channel_consent(text,uuid,uuid,text,public.notice_language,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.upgrade_channel_consent(text,uuid,uuid,text,public.notice_language,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upgrade_channel_consent(text,uuid,uuid,text,public.notice_language,text) TO transfer_app;
