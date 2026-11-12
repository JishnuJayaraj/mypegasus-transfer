CREATE OR REPLACE FUNCTION public.check_activation_delivery_address(p_token_hash text, p_address_hash text, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.participant_session; c public.activation_code;
BEGIN
  IF p_address_hash IS NULL OR p_address_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF c.channel <> 'in_person' OR s.delivery_address_checked_at IS NOT NULL
     OR public.activation_needs_birth_date(c) AND s.birth_date_checked_at IS NULL THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF p_address_hash = c.delivery_address_hash THEN
    UPDATE public.participant_session SET delivery_address_checked_at = now(), last_seen_at = now()
    WHERE token_hash = s.token_hash;
    RETURN 'ok';
  END IF;
  RETURN public.count_activation_failure(c.id, p_request_id);
END $function$;

ALTER FUNCTION public.check_activation_delivery_address(text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.check_activation_delivery_address(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_activation_delivery_address(text,text,text) TO transfer_app;
