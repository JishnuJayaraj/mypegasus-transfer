CREATE OR REPLACE FUNCTION public.appointment_member_roles(p_project_id uuid, p_staff_user_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT m.role::text FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = p_staff_user_id
    ORDER BY 1)
$function$;

ALTER FUNCTION public.appointment_member_roles(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_member_roles(uuid,uuid) FROM PUBLIC;
