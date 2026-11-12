CREATE OR REPLACE FUNCTION public.assert_global_admin(p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT FROM public.staff_org_role r JOIN public.staff_user u ON u.id = r.staff_user_id
    WHERE r.staff_user_id = p_actor AND r.role = 'admin' AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
END $function$;

ALTER FUNCTION public.assert_global_admin(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_global_admin(uuid) FROM PUBLIC;
