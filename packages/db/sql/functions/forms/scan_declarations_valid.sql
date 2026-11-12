CREATE OR REPLACE FUNCTION public.scan_declarations_valid(p_declarations jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_declarations) = 'object' AND CASE
    p_declarations ->> 'kind'
    WHEN 'as_printed' THEN
      ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k) = '{kind}'::text[]
    WHEN 'as_marked' THEN
      ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k ORDER BY k)
        = '{baContactConsent,jobboerseChoice,kind}'::text[]
      AND public.form_declarations_valid(p_declarations - 'kind')
    ELSE false END, false)
$function$;

ALTER FUNCTION public.scan_declarations_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.scan_declarations_valid(jsonb) FROM PUBLIC;
