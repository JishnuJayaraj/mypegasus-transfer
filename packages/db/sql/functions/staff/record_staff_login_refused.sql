CREATE OR REPLACE FUNCTION public.record_staff_login_refused(p_reason_code text, p_subject_staff_user_id uuid, p_method text, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('oidc', 'dev')
     OR p_reason_code IS NULL
     OR p_reason_code NOT IN ('unknown_account', 'account_deactivated', 'identity_mismatch')
     OR (p_subject_staff_user_id IS NULL) <> (p_reason_code = 'unknown_account')
     OR (p_subject_staff_user_id IS NOT NULL
       AND NOT EXISTS (SELECT FROM public.staff_user WHERE id = p_subject_staff_user_id)) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, subject_staff_user_id, reason_code, details, request_id)
  VALUES ('staff_login_refused', p_subject_staff_user_id, p_reason_code,
    jsonb_build_object('method', p_method), p_request_id);
END $function$;

ALTER FUNCTION public.record_staff_login_refused(text,uuid,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_staff_login_refused(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_staff_login_refused(text,uuid,text,text) TO transfer_app;
