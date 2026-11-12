CREATE OR REPLACE FUNCTION public.request_step_up_code(p_token_hash text, p_channel_id uuid, p_code_hash text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; ch public.participant_channel;
BEGIN
  IF p_channel_id IS NULL OR p_id IS NULL OR p_code_hash IS NULL
     OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'photo_id_and_code'
     OR public.participant_session_stepped_up(s) THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
    AND suspended_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_not_found'; END IF;
  PERFORM public.insert_one_time_code(s.project_id, s.participation_id, 'step_up', ch.kind,
    ch.address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN pg_catalog.jsonb_build_object('kind', ch.kind, 'address', ch.address);
END $function$;

ALTER FUNCTION public.request_step_up_code(text,uuid,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_step_up_code(text,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_step_up_code(text,uuid,text,uuid) TO transfer_app;
