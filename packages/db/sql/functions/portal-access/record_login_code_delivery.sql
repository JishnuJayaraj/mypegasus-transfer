CREATE OR REPLACE FUNCTION public.record_login_code_delivery(p_challenge_id uuid, p_outcome public.activation_delivery_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE ch public.one_time_code_challenge;
BEGIN
  SELECT * INTO ch FROM public.one_time_code_challenge WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR ch.purpose <> 'login' THEN RAISE EXCEPTION 'challenge_not_found'; END IF;
  IF ch.delivery_status <> 'pending' OR p_outcome NOT IN ('sent', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid_delivery_state';
  END IF;
  UPDATE public.one_time_code_challenge SET delivery_status = p_outcome,
    invalidation_reason = CASE WHEN p_outcome = 'failed' AND invalidated_at IS NULL
      AND consumed_at IS NULL THEN 'delivery_failed' ELSE invalidation_reason END,
    invalidated_at = CASE WHEN p_outcome = 'failed' AND invalidated_at IS NULL
      AND consumed_at IS NULL THEN now() ELSE invalidated_at END
  WHERE id = ch.id;
END $function$;

ALTER FUNCTION public.record_login_code_delivery(uuid,public.activation_delivery_status) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_login_code_delivery(uuid,public.activation_delivery_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_login_code_delivery(uuid,public.activation_delivery_status) TO transfer_app;
