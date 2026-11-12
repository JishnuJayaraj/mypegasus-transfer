CREATE OR REPLACE FUNCTION public.audit_history_details(p_details jsonb, p_keys text[], p_known public.access_category[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_object_agg(d.key, d.value), '{}'::jsonb)
  FROM (
    SELECT e.key, CASE
        WHEN e.key <> 'fields' THEN e.value
        WHEN pg_catalog.jsonb_typeof(e.value) = 'array' THEN (
          SELECT pg_catalog.jsonb_agg(f.value ORDER BY f.position)
          FROM pg_catalog.jsonb_array_elements_text(e.value) WITH ORDINALITY AS f(value, position)
          JOIN public.field_access_category c ON c.field_key =
            CASE WHEN f.value LIKE 'custom.%' THEN 'custom.*' ELSE f.value END
          WHERE c.access_category = ANY (p_known))
      END AS value
    FROM pg_catalog.jsonb_each(p_details) AS e(key, value)
    WHERE e.key = ANY (p_keys)
  ) d
  WHERE d.value IS NOT NULL
$function$;

ALTER FUNCTION public.audit_history_details(jsonb,text[],public.access_category[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.audit_history_details(jsonb,text[],public.access_category[]) FROM PUBLIC;
