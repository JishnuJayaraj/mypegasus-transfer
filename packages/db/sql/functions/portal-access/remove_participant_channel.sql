CREATE OR REPLACE FUNCTION public.remove_participant_channel(p_token_hash text, p_channel_id uuid, p_request_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; ch public.participant_channel; v_context public.audit_context;
BEGIN
  IF p_channel_id IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_not_found'; END IF;
  v_context := public.participant_context(s.participation_id, p_request_id);
  UPDATE public.participant_channel SET removed_at = now(), removed_reason = 'consent_revoked'
  WHERE id = ch.id;
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'revoked'
  WHERE id = ch.consent_id AND ended_at IS NULL;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_ended', v_context,
    NULL, NULL, NULL, 'revoked', NULL, pg_catalog.jsonb_build_object('consentId', ch.consent_id,
      'channelId', ch.id, 'purpose', 'portal_contact'), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'contact_channel_removed',
    v_context, NULL, NULL, NULL, 'consent_revoked', NULL,
    pg_catalog.jsonb_build_object('channelId', ch.id, 'kind', ch.kind), false);
  IF NOT EXISTS (SELECT FROM public.participant_channel
                 WHERE participation_id = s.participation_id AND removed_at IS NULL) THEN
    UPDATE public.participant_session SET ended_at = now(), end_reason = 'no_channel'
    WHERE participation_id = s.participation_id AND ended_at IS NULL;
    RETURN true;
  END IF;
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN false;
END $function$;

ALTER FUNCTION public.remove_participant_channel(text,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.remove_participant_channel(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_participant_channel(text,uuid,text) TO transfer_app;
