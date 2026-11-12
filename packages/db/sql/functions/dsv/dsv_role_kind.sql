CREATE OR REPLACE FUNCTION public.dsv_role_kind(p_participation_id uuid, p_staff_user_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN 'project_lead' = ANY (r) THEN 'project_lead' WHEN 'back_office' = ANY (r) THEN 'back_office' END
 FROM (SELECT public.document_staff_roles(p_participation_id, p_staff_user_id) AS r) x
$function$;

ALTER FUNCTION public.dsv_role_kind(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.dsv_role_kind(uuid,uuid) FROM PUBLIC;
