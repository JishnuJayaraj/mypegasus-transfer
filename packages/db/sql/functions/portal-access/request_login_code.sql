CREATE OR REPLACE FUNCTION public.request_login_code(p_kind public.contact_channel_kind, p_address text, p_code_hash text, p_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE ch public.participant_channel; p public.participation; made public.one_time_code_challenge;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL OR p_id IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE kind = p_kind AND address = p_address AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  p := public.lock_participation(ch.participation_id);
  SELECT * INTO ch FROM public.participant_channel WHERE id = ch.id;
  IF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL
     OR NOT public.participant_account_usable(p) THEN
    RETURN NULL;
  END IF;
  made := public.insert_one_time_code(p.project_id, p.id, 'login', p_kind, p_address,
    p_code_hash, p_id);
  RETURN made.id;
END $function$;

ALTER FUNCTION public.request_login_code(public.contact_channel_kind,text,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_login_code(public.contact_channel_kind,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_login_code(public.contact_channel_kind,text,text,uuid) TO transfer_app;
