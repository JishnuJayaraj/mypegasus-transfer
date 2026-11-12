CREATE OR REPLACE FUNCTION public.profiling_text_valid(v jsonb, p_max integer)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT v IS NOT NULL AND (v = 'null'::jsonb OR pg_catalog.jsonb_typeof(v) = 'string'
    AND pg_catalog.char_length(v #>> '{}') BETWEEN 1 AND p_max
    AND v #>> '{}' = pg_catalog.btrim(v #>> '{}') AND v #>> '{}' !~ '[[:cntrl:]]')
$function$;

ALTER FUNCTION public.profiling_text_valid(jsonb,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_text_valid(jsonb,integer) FROM PUBLIC;
