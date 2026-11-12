CREATE OR REPLACE FUNCTION public.form_sources_valid(p_sources jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_sources) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_sources) k ORDER BY k)
      = '{assessment,profile,profiling,unemployment}'::text[]
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_each(p_sources) e(k, v)
      WHERE pg_catalog.jsonb_typeof(v) <> 'number' OR v::text !~ '^[0-9]{1,9}$'), false)
$function$;

ALTER FUNCTION public.form_sources_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.form_sources_valid(jsonb) FROM PUBLIC;
