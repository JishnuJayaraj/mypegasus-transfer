CREATE OR REPLACE FUNCTION public.profiling_sessions_valid(p_sessions jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_typeof(p_sessions) = 'array'
    AND pg_catalog.jsonb_array_length(p_sessions) <= 50
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e(s)
      WHERE NOT (pg_catalog.jsonb_typeof(s) = 'object'
        AND (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k)
          <@ '{date,from,id,to}'::text[]
        AND s ? 'date' AND s ? 'from' AND s ? 'to'
        AND public.iso_date_valid(s -> 'date')
        AND pg_catalog.jsonb_typeof(s -> 'from') = 'string'
        AND s ->> 'from' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND pg_catalog.jsonb_typeof(s -> 'to') = 'string'
        AND s ->> 'to' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND (NOT s ? 'id' OR pg_catalog.jsonb_typeof(s -> 'id') = 'string'
          AND s ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
$function$;

ALTER FUNCTION public.profiling_sessions_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_sessions_valid(jsonb) FROM PUBLIC;
