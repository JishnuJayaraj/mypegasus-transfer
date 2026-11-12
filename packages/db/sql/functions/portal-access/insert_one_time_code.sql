CREATE OR REPLACE FUNCTION public.insert_one_time_code(p_project_id uuid, p_participation_id uuid, p_purpose public.one_time_code_purpose, p_kind public.contact_channel_kind, p_address text, p_code_hash text, p_id uuid)
 RETURNS public.one_time_code_challenge
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE made public.one_time_code_challenge;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('one-time-code:' || p_kind::text || ':' || p_address, 0));
  IF (SELECT pg_catalog.count(*) FROM public.one_time_code_challenge
      WHERE kind = p_kind AND address = p_address AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  UPDATE public.one_time_code_challenge SET invalidated_at = now(), invalidation_reason = 'superseded'
  WHERE participation_id = p_participation_id AND purpose = p_purpose
    AND consumed_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO public.one_time_code_challenge (
    id, project_id, participation_id, purpose, kind, address, code_hash, expires_at)
  VALUES (p_id, p_project_id, p_participation_id, p_purpose, p_kind, p_address, p_code_hash,
    now() + interval '15 minutes')
  RETURNING * INTO made;
  RETURN made;
END $function$;

ALTER FUNCTION public.insert_one_time_code(uuid,uuid,public.one_time_code_purpose,public.contact_channel_kind,text,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.insert_one_time_code(uuid,uuid,public.one_time_code_purpose,public.contact_channel_kind,text,text,uuid) FROM PUBLIC;
