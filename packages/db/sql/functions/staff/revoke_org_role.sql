CREATE OR REPLACE FUNCTION public.revoke_org_role(p_staff_user_id uuid, p_role public.org_role, p_region_id uuid, p_actor uuid, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.lock_admin_survivorship();
  PERFORM public.assert_global_admin(p_actor);
  IF p_role IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_staff_user_id = p_actor AND p_role = 'admin' THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  PERFORM FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  DELETE FROM public.staff_org_role
  WHERE staff_user_id = p_staff_user_id AND role = p_role AND region_id IS NOT DISTINCT FROM p_region_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_role_not_found';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('org_role_revoked', p_actor, p_staff_user_id,
    pg_catalog.jsonb_build_object('role', p_role, 'regionId', p_region_id), p_request_id);
END $function$;

ALTER FUNCTION public.revoke_org_role(uuid,public.org_role,uuid,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.revoke_org_role(uuid,public.org_role,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_org_role(uuid,public.org_role,uuid,uuid,text) TO transfer_app;
