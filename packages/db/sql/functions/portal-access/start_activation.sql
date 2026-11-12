CREATE OR REPLACE FUNCTION public.start_activation(p_code_hash text, p_token_hash text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c public.activation_code; p public.participation;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO c FROM public.activation_code WHERE code_hash = p_code_hash;
  IF NOT FOUND THEN RETURN NULL; END IF;
  p := public.lock_participation(c.participation_id);
  SELECT * INTO c FROM public.activation_code WHERE id = c.id FOR UPDATE;
  IF NOT public.activation_code_open(c) OR p.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT status FROM public.project WHERE id = p.project_id) <> 'active'
     OR EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id)
        <> (c.purpose = 'recovery') THEN
    RETURN NULL;
  END IF;
  IF c.purpose = 'activation' AND NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'before_cutoff';
  END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'superseded'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  INSERT INTO public.participant_session (token_hash, project_id, participation_id, state, activation_code_id)
  VALUES (p_token_hash, p.project_id, p.id, 'activating', c.id);
  RETURN pg_catalog.jsonb_build_object('purpose', c.purpose, 'channel', c.channel,
    'deliveryKind', c.delivery_kind, 'language', c.notice_language,
    'needsBirthDate', public.activation_needs_birth_date(c));
END $function$;

ALTER FUNCTION public.start_activation(text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.start_activation(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_activation(text,text,text) TO transfer_app;
