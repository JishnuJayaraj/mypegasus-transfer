CREATE OR REPLACE FUNCTION public.lock_assisted_mode(p_participation_id uuid, p_context public.audit_context, p_staff_session_hash text)
 RETURNS text[]
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_roles text[];
BEGIN
  IF (p_context).actor_type IS DISTINCT FROM 'user'
     OR (p_context).on_behalf_of IS DISTINCT FROM p_participation_id THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF p_staff_session_hash IS NULL OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'assisted_mode_required';
  END IF;
  PERFORM FROM public.assisted_mode m
  JOIN public.staff_session s ON s.token_hash = m.staff_session_hash
  WHERE m.staff_session_hash = p_staff_session_hash AND m.participation_id = p_participation_id
    AND m.staff_user_id = (p_context).staff_user_id AND m.ended_at IS NULL
    AND s.ended_at IS NULL AND s.expires_at > now()
  FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assisted_mode_required';
  END IF;
  v_roles := public.assisted_mode_roles(p_participation_id, (p_context).staff_user_id);
  IF pg_catalog.cardinality(v_roles) = 0 THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  RETURN v_roles;
END $function$;

ALTER FUNCTION public.lock_assisted_mode(uuid,public.audit_context,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_assisted_mode(uuid,public.audit_context,text) FROM PUBLIC;
