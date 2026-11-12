CREATE OR REPLACE FUNCTION public.staff_text_valid(p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_value IS NOT NULL AND p_value = pg_catalog.btrim(p_value)
    AND pg_catalog.length(p_value) BETWEEN 1 AND 100 AND p_value !~ '[[:cntrl:]]'
$function$;

ALTER FUNCTION public.staff_text_valid(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.staff_text_valid(text) FROM PUBLIC;
