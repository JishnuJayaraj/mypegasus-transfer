CREATE OR REPLACE FUNCTION public.region_code_valid(p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_value IS NOT NULL AND p_value ~ '^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])?$'
$function$;

ALTER FUNCTION public.region_code_valid(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.region_code_valid(text) FROM PUBLIC;
