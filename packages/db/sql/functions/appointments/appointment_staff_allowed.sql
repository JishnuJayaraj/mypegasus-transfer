CREATE OR REPLACE FUNCTION public.appointment_staff_allowed(p_participation_id uuid, p_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT public.document_staff_roles(p_participation_id, p_staff_user_id)
    && '{project_lead,consultant}'::text[]
$function$;

ALTER FUNCTION public.appointment_staff_allowed(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_staff_allowed(uuid,uuid) FROM PUBLIC;
