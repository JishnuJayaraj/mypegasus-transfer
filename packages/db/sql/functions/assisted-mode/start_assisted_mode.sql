CREATE OR REPLACE FUNCTION public.start_assisted_mode(p_participation_id uuid, p_context public.audit_context, p_staff_session_hash text, p_how public.assisted_mode_how, p_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; m public.assisted_mode;
BEGIN
  IF p_how IS NULL OR p_id IS NULL OR p_staff_session_hash IS NULL
     OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_staff_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL
  FOR SHARE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF pg_catalog.cardinality(public.assisted_mode_roles(r.id, (p_context).staff_user_id)) = 0 THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  FOR m IN SELECT a.* FROM public.assisted_mode a
           JOIN public.staff_session s ON s.token_hash = a.staff_session_hash
           WHERE a.staff_user_id = (p_context).staff_user_id AND a.ended_at IS NULL
             AND (a.staff_session_hash = p_staff_session_hash AND a.participation_id = r.id
               OR s.ended_at IS NOT NULL OR s.expires_at <= now())
           ORDER BY a.started_at FOR UPDATE OF a LOOP
    PERFORM public.close_assisted_mode(m, CASE WHEN m.staff_session_hash = p_staff_session_hash
      THEN 'ended' ELSE 'staff_session_ended' END::public.assisted_mode_end_reason,
      (p_context).request_id);
  END LOOP;
  INSERT INTO public.assisted_mode (id, project_id, participation_id, staff_user_id,
    staff_session_hash, how)
  VALUES (p_id, r.project_id, r.id, (p_context).staff_user_id, p_staff_session_hash, p_how);
  PERFORM public.write_audit_event(r.project_id, r.id, 'assisted_mode_started', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('assistedModeId', p_id, 'how', p_how),
    false);
  RETURN p_id;
END $function$;

ALTER FUNCTION public.start_assisted_mode(uuid,public.audit_context,text,public.assisted_mode_how,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.start_assisted_mode(uuid,public.audit_context,text,public.assisted_mode_how,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_assisted_mode(uuid,public.audit_context,text,public.assisted_mode_how,uuid) TO transfer_app;
