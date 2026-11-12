CREATE OR REPLACE FUNCTION public.grant_org_role(p_staff_user_id uuid, p_role public.org_role, p_region_id uuid, p_actor uuid, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_role IS NULL OR (p_role = 'admin') <> (p_region_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_region_id IS NOT NULL AND NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  INSERT INTO public.staff_org_role (staff_user_id, role, region_id, granted_by)
  VALUES (p_staff_user_id, p_role, p_region_id, p_actor)
  ON CONFLICT ON CONSTRAINT staff_org_role_unique DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_role_exists';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('org_role_granted', p_actor, p_staff_user_id,
    pg_catalog.jsonb_build_object('role', p_role, 'regionId', p_region_id), p_request_id);
END $function$;

ALTER FUNCTION public.grant_org_role(uuid,public.org_role,uuid,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.grant_org_role(uuid,public.org_role,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_org_role(uuid,public.org_role,uuid,uuid,text) TO transfer_app;
