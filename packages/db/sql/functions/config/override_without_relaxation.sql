CREATE OR REPLACE FUNCTION public.override_without_relaxation(p_content jsonb, p_rule_id text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN r -> 'relax' = '[]'::jsonb THEN r - 'relax' ELSE r END
  FROM (SELECT CASE WHEN pg_catalog.jsonb_typeof(p_content -> 'relax') = 'array'
    THEN pg_catalog.jsonb_set(p_content, '{relax}', coalesce((
      SELECT pg_catalog.jsonb_agg(e.value ORDER BY e.ordinality)
      FROM pg_catalog.jsonb_array_elements(p_content -> 'relax') WITH ORDINALITY e
      WHERE e.value ->> 'ruleId' IS DISTINCT FROM p_rule_id), '[]'::jsonb))
    ELSE p_content END AS r) s
$function$;

ALTER FUNCTION public.override_without_relaxation(jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.override_without_relaxation(jsonb,text) FROM PUBLIC;
