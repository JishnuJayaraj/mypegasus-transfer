CREATE OR REPLACE FUNCTION public.profiling_assessment_lines()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT '{schoolQualification,vocationalQualification,workExperience,languageSkills,otherQualification,intellectualCapacity,workAndSocialBehaviour,otherPerformance,initiative,learningReadiness,otherMotivation,localMobility,otherConditions}'::text[]
$function$;

ALTER FUNCTION public.profiling_assessment_lines() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_assessment_lines() FROM PUBLIC;
