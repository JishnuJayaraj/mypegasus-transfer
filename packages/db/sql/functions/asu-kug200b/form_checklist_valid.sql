CREATE OR REPLACE FUNCTION public.form_checklist_valid(p_checklist jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_checklist) = 'array'
    AND pg_catalog.jsonb_array_length(p_checklist) <= 50
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_array_elements(p_checklist) e(v)
      WHERE pg_catalog.jsonb_typeof(v) <> 'object'
        OR ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(v) k ORDER BY k) <> '{code,key}'::text[]
        OR v ->> 'code' NOT IN ('required_blank', 'text_not_fitting')
        OR v ->> 'key' !~ '^[A-Za-z][A-Za-z0-9_.]{0,99}$'), false)
$function$;

ALTER FUNCTION public.form_checklist_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.form_checklist_valid(jsonb) FROM PUBLIC;
