CREATE OR REPLACE FUNCTION public.profiling_assessment_values(p_fields jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT (
    SELECT pg_catalog.jsonb_object_agg(l, coalesce(
      nullif(p_fields -> ('profilingAssessment.' || l), 'null'::jsonb),
      CASE WHEN l = ANY (public.profiling_other_lines())
           THEN '{"rating": null, "text": null, "label": null}'::jsonb
           ELSE '{"rating": null, "text": null}'::jsonb END))
    FROM pg_catalog.unnest(public.profiling_assessment_lines()) l)
    || pg_catalog.jsonb_build_object(
      'health', pg_catalog.jsonb_build_object('rating',
        coalesce(p_fields -> 'profilingHealthAssessment', 'null'::jsonb)),
      'overallAssessment', coalesce(p_fields -> 'overallAssessment', 'null'::jsonb),
      'nextSteps', coalesce(p_fields -> 'nextSteps', 'null'::jsonb))
$function$;

ALTER FUNCTION public.profiling_assessment_values(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_assessment_values(jsonb) FROM PUBLIC;
