CREATE OR REPLACE FUNCTION public.write_profiling_assessment(p_participation_id uuid, p_context public.audit_context, p_values jsonb, p_revision integer, p_key text, p_key_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_old jsonb;
  v_new jsonb;
  v_revision integer;
  v_changed text[];
  v_field text;
  o text := 'profilingAssessment.';
BEGIN
  IF p_values IS NOT NULL AND pg_catalog.jsonb_typeof(p_values -> 'health') = 'object'
     AND EXISTS (SELECT FROM pg_catalog.jsonb_object_keys(p_values -> 'health') k
                 WHERE k <> 'rating') THEN
    RAISE EXCEPTION 'health_detail_not_recorded';
  END IF;
  IF p_values IS NULL OR NOT public.profiling_assessment_valid(p_values)
     OR p_revision IS NULL OR p_revision < 0
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  r := public.lock_profiler(p_participation_id, p_context);
  PERFORM FROM public.participant_profiling_assessment WHERE participation_id = r.id FOR UPDATE;
  PERFORM FROM public.participant_profiling_health_assessment WHERE participation_id = r.id
  FOR UPDATE;
  v_old := public.open_profiling_assessment(r.id, p_key, p_key_id);
  v_revision := (v_old ->> 'revision')::integer;
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  v_new := public.profiling_assessment_fields(p_values);
  SELECT coalesce(pg_catalog.array_agg(f ORDER BY n), '{}') INTO v_changed
  FROM pg_catalog.jsonb_object_keys(v_new) WITH ORDINALITY AS u(f, n)
  WHERE nullif(v_old -> 'fields' -> f, 'null'::jsonb) IS DISTINCT FROM nullif(v_new -> f, 'null'::jsonb);
  IF pg_catalog.cardinality(v_changed) = 0 THEN
    RETURN v_revision;
  END IF;

  INSERT INTO public.participant_profiling_assessment (participation_id, project_id,
    school_qualification, school_qualification_present,
    vocational_qualification, vocational_qualification_present,
    work_experience, work_experience_present, language_skills, language_skills_present,
    other_qualification, other_qualification_present,
    intellectual_capacity, intellectual_capacity_present,
    work_and_social_behaviour, work_and_social_behaviour_present,
    other_performance, other_performance_present, initiative, initiative_present,
    learning_readiness, learning_readiness_present, other_motivation, other_motivation_present,
    local_mobility, local_mobility_present, other_conditions, other_conditions_present,
    overall_assessment, overall_assessment_present, next_steps, next_steps_present,
    key_id, revision)
  VALUES (r.id, r.project_id,
    public.seal_sensitive_value(r.id, o || 'schoolQualification',
      v_new -> (o || 'schoolQualification'), p_key),
    v_new -> (o || 'schoolQualification') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'vocationalQualification',
      v_new -> (o || 'vocationalQualification'), p_key),
    v_new -> (o || 'vocationalQualification') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'workExperience',
      v_new -> (o || 'workExperience'), p_key),
    v_new -> (o || 'workExperience') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'languageSkills',
      v_new -> (o || 'languageSkills'), p_key),
    v_new -> (o || 'languageSkills') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'otherQualification',
      v_new -> (o || 'otherQualification'), p_key),
    v_new -> (o || 'otherQualification') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'intellectualCapacity',
      v_new -> (o || 'intellectualCapacity'), p_key),
    v_new -> (o || 'intellectualCapacity') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'workAndSocialBehaviour',
      v_new -> (o || 'workAndSocialBehaviour'), p_key),
    v_new -> (o || 'workAndSocialBehaviour') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'otherPerformance',
      v_new -> (o || 'otherPerformance'), p_key),
    v_new -> (o || 'otherPerformance') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'initiative', v_new -> (o || 'initiative'), p_key),
    v_new -> (o || 'initiative') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'learningReadiness',
      v_new -> (o || 'learningReadiness'), p_key),
    v_new -> (o || 'learningReadiness') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'otherMotivation',
      v_new -> (o || 'otherMotivation'), p_key),
    v_new -> (o || 'otherMotivation') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'localMobility',
      v_new -> (o || 'localMobility'), p_key),
    v_new -> (o || 'localMobility') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, o || 'otherConditions',
      v_new -> (o || 'otherConditions'), p_key),
    v_new -> (o || 'otherConditions') <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, 'overallAssessment', v_new -> 'overallAssessment', p_key),
    v_new -> 'overallAssessment' <> 'null'::jsonb,
    public.seal_sensitive_value(r.id, 'nextSteps', v_new -> 'nextSteps', p_key),
    v_new -> 'nextSteps' <> 'null'::jsonb,
    p_key_id, v_revision + 1)
  ON CONFLICT (participation_id) DO UPDATE SET
    school_qualification = EXCLUDED.school_qualification,
    school_qualification_present = EXCLUDED.school_qualification_present,
    vocational_qualification = EXCLUDED.vocational_qualification,
    vocational_qualification_present = EXCLUDED.vocational_qualification_present,
    work_experience = EXCLUDED.work_experience,
    work_experience_present = EXCLUDED.work_experience_present,
    language_skills = EXCLUDED.language_skills,
    language_skills_present = EXCLUDED.language_skills_present,
    other_qualification = EXCLUDED.other_qualification,
    other_qualification_present = EXCLUDED.other_qualification_present,
    intellectual_capacity = EXCLUDED.intellectual_capacity,
    intellectual_capacity_present = EXCLUDED.intellectual_capacity_present,
    work_and_social_behaviour = EXCLUDED.work_and_social_behaviour,
    work_and_social_behaviour_present = EXCLUDED.work_and_social_behaviour_present,
    other_performance = EXCLUDED.other_performance,
    other_performance_present = EXCLUDED.other_performance_present,
    initiative = EXCLUDED.initiative, initiative_present = EXCLUDED.initiative_present,
    learning_readiness = EXCLUDED.learning_readiness,
    learning_readiness_present = EXCLUDED.learning_readiness_present,
    other_motivation = EXCLUDED.other_motivation,
    other_motivation_present = EXCLUDED.other_motivation_present,
    local_mobility = EXCLUDED.local_mobility,
    local_mobility_present = EXCLUDED.local_mobility_present,
    other_conditions = EXCLUDED.other_conditions,
    other_conditions_present = EXCLUDED.other_conditions_present,
    overall_assessment = EXCLUDED.overall_assessment,
    overall_assessment_present = EXCLUDED.overall_assessment_present,
    next_steps = EXCLUDED.next_steps, next_steps_present = EXCLUDED.next_steps_present,
    key_id = EXCLUDED.key_id, revision = EXCLUDED.revision, written_at = pg_catalog.now();
  INSERT INTO public.participant_profiling_health_assessment (participation_id, project_id,
    health_rating, health_rating_present, key_id)
  VALUES (r.id, r.project_id,
    public.seal_sensitive_value(r.id, 'profilingHealthAssessment',
      v_new -> 'profilingHealthAssessment', p_key),
    v_new -> 'profilingHealthAssessment' <> 'null'::jsonb, p_key_id)
  ON CONFLICT (participation_id) DO UPDATE SET health_rating = EXCLUDED.health_rating,
    health_rating_present = EXCLUDED.health_rating_present, key_id = EXCLUDED.key_id,
    written_at = pg_catalog.now();
  FOREACH v_field IN ARRAY v_changed LOOP
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', v_field), false);
  END LOOP;
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_profiling_assessment(uuid,public.audit_context,jsonb,integer,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_profiling_assessment(uuid,public.audit_context,jsonb,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_profiling_assessment(uuid,public.audit_context,jsonb,integer,text,text) TO transfer_app;
