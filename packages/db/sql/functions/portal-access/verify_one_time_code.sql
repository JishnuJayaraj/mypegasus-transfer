CREATE OR REPLACE FUNCTION public.verify_one_time_code(p_participation_id uuid, p_purpose public.one_time_code_purpose, p_code_hash text, p_request_id text, p_kind public.contact_channel_kind DEFAULT NULL::public.contact_channel_kind, p_address text DEFAULT NULL::text, OUT result text, OUT challenge_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE challenge public.one_time_code_challenge;
BEGIN
  SELECT * INTO challenge FROM public.one_time_code_challenge
  WHERE participation_id = p_participation_id AND purpose = p_purpose AND consumed_at IS NULL
    AND invalidated_at IS NULL AND expires_at > now() AND failed_attempts < 5
    AND (p_kind IS NULL OR kind = p_kind AND address = p_address)
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN result := 'none'; RETURN; END IF;
  challenge_id := challenge.id;
  IF challenge.code_hash = p_code_hash THEN
    UPDATE public.one_time_code_challenge SET consumed_at = now() WHERE id = challenge.id;
    result := 'ok';
    RETURN;
  END IF;
  UPDATE public.one_time_code_challenge SET failed_attempts = failed_attempts + 1
  WHERE id = challenge.id RETURNING * INTO challenge;
  IF challenge.failed_attempts < 5 THEN result := 'mismatch'; RETURN; END IF;
  PERFORM public.write_audit_event(challenge.project_id, challenge.participation_id,
    'one_time_code_exhausted', public.portal_system_context(p_request_id), NULL, NULL, NULL, NULL,
    NULL, pg_catalog.jsonb_build_object('challengeId', challenge.id, 'purpose', challenge.purpose),
    false);
  result := 'exhausted';
END $function$;

ALTER FUNCTION public.verify_one_time_code(uuid,public.one_time_code_purpose,text,text,public.contact_channel_kind,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.verify_one_time_code(uuid,public.one_time_code_purpose,text,text,public.contact_channel_kind,text) FROM PUBLIC;
