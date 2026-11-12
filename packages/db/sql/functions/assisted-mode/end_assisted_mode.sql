CREATE OR REPLACE FUNCTION public.end_assisted_mode(p_participation_id uuid, p_context public.audit_context, p_staff_session_hash text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE m public.assisted_mode;
BEGIN
  IF p_staff_session_hash IS NULL OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO m FROM public.assisted_mode
  WHERE staff_session_hash = p_staff_session_hash AND participation_id = p_participation_id
    AND staff_user_id = (p_context).staff_user_id AND ended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.close_assisted_mode(m, 'ended', (p_context).request_id);
  RETURN true;
END $function$;

ALTER FUNCTION public.end_assisted_mode(uuid,public.audit_context,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.end_assisted_mode(uuid,public.audit_context,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_assisted_mode(uuid,public.audit_context,text) TO transfer_app;
