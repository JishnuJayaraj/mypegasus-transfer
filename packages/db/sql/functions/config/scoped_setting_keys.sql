CREATE OR REPLACE FUNCTION public.scoped_setting_keys(p_setting jsonb)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.array_agg(s.key || '.' || k ORDER BY (s.key || '.' || k) COLLATE "C"), '{}')
  FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(p_setting -> 'settings') = 'object'
    THEN p_setting -> 'settings' ELSE '{}'::jsonb END) s
  CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(
    CASE WHEN pg_catalog.jsonb_typeof(s.value) = 'object' THEN s.value ELSE '{}'::jsonb END) k
$function$;

ALTER FUNCTION public.scoped_setting_keys(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.scoped_setting_keys(jsonb) FROM PUBLIC;
