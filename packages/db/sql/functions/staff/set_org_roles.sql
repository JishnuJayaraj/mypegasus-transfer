CREATE OR REPLACE FUNCTION public.set_org_roles(p_staff_user_id uuid, p_roles public.org_role[], p_region_ids uuid[], p_actor uuid, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
  r record;
BEGIN
  PERFORM public.lock_admin_survivorship();
  PERFORM public.assert_global_admin(p_actor);
  IF p_staff_user_id IS NULL OR p_roles IS NULL OR p_region_ids IS NULL
     OR pg_catalog.cardinality(p_roles) <> pg_catalog.cardinality(p_region_ids)
     OR pg_catalog.cardinality(p_roles) > 20
     OR EXISTS (
       SELECT FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       WHERE w.role IS NULL OR (w.role = 'admin') IS DISTINCT FROM (w.region_id IS NULL))
     OR (SELECT count(*) FROM (
       SELECT w.role, w.region_id
       FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       GROUP BY w.role, w.region_id
     ) distinct_roles) <> pg_catalog.cardinality(p_roles) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF EXISTS (
    SELECT FROM ROWS FROM (
      pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
    ) AS w(role, region_id)
    WHERE w.region_id IS NOT NULL
      AND NOT EXISTS (SELECT FROM public.region WHERE id = w.region_id)) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  IF p_staff_user_id = p_actor
     AND EXISTS (SELECT FROM public.staff_org_role WHERE staff_user_id = p_actor AND role = 'admin')
     AND NOT EXISTS (
       SELECT FROM ROWS FROM (
         pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
       ) AS w(role, region_id)
       WHERE w.role = 'admin' AND w.region_id IS NULL) THEN
    RAISE EXCEPTION 'own_account';
  END IF;
  FOR r IN
    SELECT held.role, held.region_id
    FROM public.staff_org_role held
    WHERE held.staff_user_id = p_staff_user_id AND NOT EXISTS (
      SELECT FROM ROWS FROM (
        pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
      ) AS w(role, region_id)
      WHERE w.role = held.role AND w.region_id IS NOT DISTINCT FROM held.region_id)
    ORDER BY held.role::text, held.region_id NULLS FIRST
  LOOP
    PERFORM public.revoke_org_role(
      p_staff_user_id, r.role, r.region_id, p_actor, p_request_id);
  END LOOP;
  FOR r IN
    SELECT w.role, w.region_id
    FROM ROWS FROM (
      pg_catalog.unnest(p_roles), pg_catalog.unnest(p_region_ids)
    ) AS w(role, region_id)
    WHERE NOT EXISTS (
      SELECT FROM public.staff_org_role held
      WHERE held.staff_user_id = p_staff_user_id AND held.role = w.role
        AND held.region_id IS NOT DISTINCT FROM w.region_id)
    ORDER BY w.role::text, w.region_id NULLS FIRST
  LOOP
    PERFORM public.grant_org_role(
      p_staff_user_id, r.role, r.region_id, p_actor, p_request_id);
  END LOOP;
END $function$;

ALTER FUNCTION public.set_org_roles(uuid,public.org_role[],uuid[],uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_org_roles(uuid,public.org_role[],uuid[],uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_org_roles(uuid,public.org_role[],uuid[],uuid,text) TO transfer_app;
