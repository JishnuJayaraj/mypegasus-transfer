CREATE OR REPLACE FUNCTION public.kug200b_batch_lead(p_project_id uuid, p_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = p_staff_user_id
      AND m.role = 'project_lead')
$function$;

ALTER FUNCTION public.kug200b_batch_lead(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_lead(uuid,uuid) FROM PUBLIC;
