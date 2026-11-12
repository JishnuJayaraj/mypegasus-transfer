CREATE OR REPLACE FUNCTION public.open_profiling_assessment(p_participation_id uuid, p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  a public.participant_profiling_assessment;
  h public.participant_profiling_health_assessment;
  o text := 'profilingAssessment.';
BEGIN
  SELECT * INTO a FROM public.participant_profiling_assessment
  WHERE participation_id = p_participation_id;
  SELECT * INTO h FROM public.participant_profiling_health_assessment
  WHERE participation_id = p_participation_id;
  IF a.key_id <> p_key_id OR h.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  RETURN pg_catalog.jsonb_build_object('revision', coalesce(a.revision, 0), 'fields',
    pg_catalog.jsonb_build_object(
      o || 'schoolQualification', public.open_sensitive_value(p_participation_id,
        o || 'schoolQualification', a.school_qualification, p_key),
      o || 'vocationalQualification', public.open_sensitive_value(p_participation_id,
        o || 'vocationalQualification', a.vocational_qualification, p_key),
      o || 'workExperience', public.open_sensitive_value(p_participation_id,
        o || 'workExperience', a.work_experience, p_key),
      o || 'languageSkills', public.open_sensitive_value(p_participation_id,
        o || 'languageSkills', a.language_skills, p_key),
      o || 'otherQualification', public.open_sensitive_value(p_participation_id,
        o || 'otherQualification', a.other_qualification, p_key),
      o || 'intellectualCapacity', public.open_sensitive_value(p_participation_id,
        o || 'intellectualCapacity', a.intellectual_capacity, p_key),
      o || 'workAndSocialBehaviour', public.open_sensitive_value(p_participation_id,
        o || 'workAndSocialBehaviour', a.work_and_social_behaviour, p_key),
      o || 'otherPerformance', public.open_sensitive_value(p_participation_id,
        o || 'otherPerformance', a.other_performance, p_key),
      o || 'initiative', public.open_sensitive_value(p_participation_id,
        o || 'initiative', a.initiative, p_key),
      o || 'learningReadiness', public.open_sensitive_value(p_participation_id,
        o || 'learningReadiness', a.learning_readiness, p_key),
      o || 'otherMotivation', public.open_sensitive_value(p_participation_id,
        o || 'otherMotivation', a.other_motivation, p_key),
      o || 'localMobility', public.open_sensitive_value(p_participation_id,
        o || 'localMobility', a.local_mobility, p_key),
      o || 'otherConditions', public.open_sensitive_value(p_participation_id,
        o || 'otherConditions', a.other_conditions, p_key),
      'overallAssessment', public.open_sensitive_value(p_participation_id, 'overallAssessment',
        a.overall_assessment, p_key),
      'nextSteps', public.open_sensitive_value(p_participation_id, 'nextSteps', a.next_steps,
        p_key),
      'profilingHealthAssessment', public.open_sensitive_value(p_participation_id,
        'profilingHealthAssessment', h.health_rating, p_key)));
END $function$;

ALTER FUNCTION public.open_profiling_assessment(uuid,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.open_profiling_assessment(uuid,text,text) FROM PUBLIC;
