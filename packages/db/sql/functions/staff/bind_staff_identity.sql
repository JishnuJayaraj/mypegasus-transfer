CREATE OR REPLACE FUNCTION public.bind_staff_identity(p_staff_user_id uuid, p_oidc_issuer text, p_oidc_subject text, p_matched_by text, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
BEGIN
  IF p_staff_user_id IS NULL OR p_matched_by IS NULL
     OR p_matched_by NOT IN ('email', 'preferred_username')
     OR p_oidc_issuer IS NULL OR p_oidc_issuer !~ '^https?://[!-~]{1,255}$'
     OR p_oidc_subject IS NULL OR p_oidc_subject !~ '^[!-~]{1,255}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF u.oidc_subject IS NOT NULL THEN
    RAISE EXCEPTION 'identity_mismatch';
  END IF;
  BEGIN
    UPDATE public.staff_user SET oidc_issuer = p_oidc_issuer, oidc_subject = p_oidc_subject
    WHERE id = u.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'identity_mismatch';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_identity_bound', u.id, u.id, jsonb_build_object('matchedBy', p_matched_by), p_request_id);
END $function$;

ALTER FUNCTION public.bind_staff_identity(uuid,text,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.bind_staff_identity(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_staff_identity(uuid,text,text,text,text) TO transfer_app;
