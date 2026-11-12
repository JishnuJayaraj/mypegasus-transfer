CREATE OR REPLACE FUNCTION public.request_channel_code(p_token_hash text, p_kind public.contact_channel_kind, p_address text, p_code_hash text, p_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; made public.one_time_code_challenge;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL OR p_id IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  PERFORM public.assert_channel_available(s.participation_id, p_kind, p_address);
  made := public.insert_one_time_code(s.project_id, s.participation_id, 'channel_verification',
    p_kind, p_address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN made.expires_at;
END $function$;

ALTER FUNCTION public.request_channel_code(text,public.contact_channel_kind,text,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_channel_code(text,public.contact_channel_kind,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_channel_code(text,public.contact_channel_kind,text,text,uuid) TO transfer_app;
