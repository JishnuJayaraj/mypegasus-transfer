CREATE OR REPLACE FUNCTION public.project_lock_key(p_project_id uuid)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.hashtextextended('project:' || p_project_id::text, 0)
$function$;

ALTER FUNCTION public.project_lock_key(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.project_lock_key(uuid) FROM PUBLIC;
