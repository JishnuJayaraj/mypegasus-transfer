CREATE OR REPLACE FUNCTION public.end_staff_session(p_token_hash text, p_request_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_staff_user_id uuid;
BEGIN
  UPDATE public.staff_session SET ended_at = now(), end_reason = 'logout'
  WHERE token_hash = p_token_hash AND ended_at IS NULL AND expires_at > now()
  RETURNING staff_user_id INTO v_staff_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, request_id)
  VALUES ('staff_logout', v_staff_user_id, v_staff_user_id, p_request_id);
  RETURN true;
END $function$;

ALTER FUNCTION public.end_staff_session(text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.end_staff_session(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_staff_session(text,text) TO transfer_app;
