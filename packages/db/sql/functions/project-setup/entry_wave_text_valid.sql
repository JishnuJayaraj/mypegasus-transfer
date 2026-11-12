CREATE OR REPLACE FUNCTION public.entry_wave_text_valid(p_code text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(p_code ~ '^[A-Za-z0-9_-]{1,20}$' AND p_name = pg_catalog.btrim(p_name)
    AND pg_catalog.length(p_name) BETWEEN 1 AND 100 AND p_name !~ '[[:cntrl:]]', false)
$function$;

ALTER FUNCTION public.entry_wave_text_valid(text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.entry_wave_text_valid(text,text) FROM PUBLIC;
