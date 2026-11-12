CREATE OR REPLACE FUNCTION public.appointment_text_valid(p_value text, p_max integer)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_value IS NOT NULL AND pg_catalog.char_length(p_value) BETWEEN 1 AND p_max
    AND p_value = pg_catalog.btrim(p_value) AND p_value !~ '[[:cntrl:]]'
$function$;

ALTER FUNCTION public.appointment_text_valid(text,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.appointment_text_valid(text,integer) FROM PUBLIC;
