CREATE OR REPLACE FUNCTION public.override_relaxations_of(p_content jsonb, p_rule_id text)
 RETURNS SETOF jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT e FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_content -> 'relax') = 'array' THEN p_content -> 'relax'
      ELSE '[]'::jsonb END) e
  WHERE e ->> 'ruleId' = p_rule_id
$function$;

ALTER FUNCTION public.override_relaxations_of(jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.override_relaxations_of(jsonb,text) FROM PUBLIC;
