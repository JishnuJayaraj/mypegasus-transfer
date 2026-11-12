CREATE OR REPLACE FUNCTION public.profiling_other_lines()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT '{otherQualification,otherPerformance,otherMotivation,otherConditions}'::text[]
$function$;

ALTER FUNCTION public.profiling_other_lines() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_other_lines() FROM PUBLIC;
