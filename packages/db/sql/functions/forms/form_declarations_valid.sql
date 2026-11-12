CREATE OR REPLACE FUNCTION public.form_declarations_valid(p_declarations jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_declarations) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_declarations) k ORDER BY k)
      = '{baContactConsent,jobboerseChoice}'::text[]
    AND (p_declarations -> 'jobboerseChoice' = 'null'::jsonb
      OR p_declarations ->> 'jobboerseChoice'
        = ANY (pg_catalog.enum_range(NULL::public.jobboerse_choice)::text[]))
    AND pg_catalog.jsonb_typeof(p_declarations -> 'baContactConsent') IN ('null', 'boolean'),
    false)
$function$;

ALTER FUNCTION public.form_declarations_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.form_declarations_valid(jsonb) FROM PUBLIC;
