CREATE OR REPLACE FUNCTION public.start_staff_session(p_staff_user_id uuid, p_token_hash text, p_method text, p_oidc_issuer text, p_oidc_subject text, p_superseded_token_hash text, p_request_id text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
  v_expires_at timestamptz;
BEGIN
  IF p_staff_user_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_method IS NULL OR p_method NOT IN ('oidc', 'dev')
     OR (p_method = 'oidc') <> (num_nonnulls(p_oidc_issuer, p_oidc_subject) = 2)
     OR (p_method = 'dev' AND num_nonnulls(p_oidc_issuer, p_oidc_subject) > 0) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Shared: a deactivation (which locks the row for update) never interleaves.
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_method = 'oidc' AND (u.oidc_issuer IS DISTINCT FROM p_oidc_issuer
      OR u.oidc_subject IS DISTINCT FROM p_oidc_subject) THEN
    RAISE EXCEPTION 'identity_mismatch';
  END IF;
  IF p_superseded_token_hash IS NOT NULL THEN
    UPDATE public.staff_session SET ended_at = now(), end_reason = 'superseded'
    WHERE token_hash = p_superseded_token_hash AND ended_at IS NULL AND expires_at > now();
  END IF;
  INSERT INTO public.staff_session (token_hash, staff_user_id, created_at, expires_at)
  VALUES (p_token_hash, u.id, now(), now() + interval '8 hours')
  RETURNING expires_at INTO v_expires_at;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_login', u.id, u.id, jsonb_build_object('method', p_method), p_request_id);
  RETURN v_expires_at;
END $function$;

ALTER FUNCTION public.start_staff_session(uuid,text,text,text,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.start_staff_session(uuid,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_staff_session(uuid,text,text,text,text,text,text) TO transfer_app;
