CREATE OR REPLACE FUNCTION public.profiling_rating_valid(v jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT v IS NOT NULL AND (v = 'null'::jsonb OR v #>> '{}' IN ('no_need', 'placement_relevant')
    AND pg_catalog.jsonb_typeof(v) = 'string')
$function$;

ALTER FUNCTION public.profiling_rating_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_rating_valid(jsonb) FROM PUBLIC;
