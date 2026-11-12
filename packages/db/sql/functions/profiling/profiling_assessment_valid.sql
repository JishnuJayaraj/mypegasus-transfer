CREATE OR REPLACE FUNCTION public.profiling_assessment_valid(p_values jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_typeof(p_values) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values) k ORDER BY k)
      = ARRAY(SELECT k FROM pg_catalog.unnest(public.profiling_assessment_lines()
          || '{health,overallAssessment,nextSteps}'::text[]) k ORDER BY k)
    AND NOT EXISTS (
      SELECT FROM pg_catalog.unnest(public.profiling_assessment_lines()) l
      WHERE NOT (pg_catalog.jsonb_typeof(p_values -> l) = 'object'
        AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values -> l) k ORDER BY k)
          = CASE WHEN l = ANY (public.profiling_other_lines()) THEN '{label,rating,text}'::text[]
                 ELSE '{rating,text}'::text[] END
        AND public.profiling_rating_valid(p_values -> l -> 'rating')
        AND public.profiling_text_valid(p_values -> l -> 'text', 300)
        AND (NOT l = ANY (public.profiling_other_lines())
          OR public.profiling_text_valid(p_values -> l -> 'label', 100))))
    AND pg_catalog.jsonb_typeof(p_values -> 'health') = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values -> 'health') k) = '{rating}'
    AND public.profiling_rating_valid(p_values -> 'health' -> 'rating')
    AND public.profiling_multiline_valid(p_values -> 'overallAssessment', 2000)
    AND public.profiling_multiline_valid(p_values -> 'nextSteps', 2000)
$function$;

ALTER FUNCTION public.profiling_assessment_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_assessment_valid(jsonb) FROM PUBLIC;
