CREATE OR REPLACE FUNCTION public.profiling_assessment_fields(p_values jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT (
    SELECT pg_catalog.jsonb_object_agg('profilingAssessment.' || l,
      CASE WHEN EXISTS (SELECT FROM pg_catalog.jsonb_each(p_values -> l) e(k, v)
                        WHERE v <> 'null'::jsonb)
           THEN p_values -> l ELSE 'null'::jsonb END)
    FROM pg_catalog.unnest(public.profiling_assessment_lines()) l)
    || pg_catalog.jsonb_build_object(
      'overallAssessment', p_values -> 'overallAssessment',
      'nextSteps', p_values -> 'nextSteps',
      'profilingHealthAssessment', p_values -> 'health' -> 'rating')
$function$;

ALTER FUNCTION public.profiling_assessment_fields(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_assessment_fields(jsonb) FROM PUBLIC;
