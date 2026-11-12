CREATE OR REPLACE FUNCTION public.staff_email_valid(p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_value IS NOT NULL AND p_value ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
    AND pg_catalog.length(p_value) <= 254
$function$;

ALTER FUNCTION public.staff_email_valid(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.staff_email_valid(text) FROM PUBLIC;
