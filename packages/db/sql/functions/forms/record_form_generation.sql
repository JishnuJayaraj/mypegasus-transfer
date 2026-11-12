CREATE OR REPLACE FUNCTION public.record_form_generation(p_context public.audit_context, p_participation_id uuid, p_generation_id uuid, p_document_id uuid, p_form_code public.form_code, p_form_version text, p_sources jsonb, p_person jsonb, p_source_token text, p_organisation_sha256 text, p_declarations jsonb, p_confirmed_warnings text[], p_anlage boolean, p_size_bytes integer, p_content_sha256 text, p_key_id text, p_wrapped_key bytea, p_checklist jsonb DEFAULT NULL::jsonb, p_employer_sha256 text DEFAULT NULL::text, p_offer_deadline date DEFAULT NULL::date, p_deadline_kind public.dsv_deadline_kind DEFAULT NULL::public.dsv_deadline_kind, p_batch_size integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_dsv boolean := p_form_code::text = 'dsv';
  v_kug boolean := p_form_code::text = 'kug200b';
  pol public.document_type_policy;
  r public.participation;
  pj public.project;
  w public.project_entry_wave;
  pr public.participant_profiling;
  v_profile integer;
  v_assessment integer;
  v_unemployment integer;
  v_code text;
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date;
  v_tg_start date;
  v_project_id uuid;
  v_type text;
  -- An IF condition ends at its first THEN, so the pattern is chosen here.
  v_version_pattern text := CASE WHEN p_form_code::text = 'dsv' THEN '^v[1-9][0-9]{0,3}$'
    ELSE '^(0[1-9]|1[0-2])-[0-9]{4}$' END;
BEGIN
  IF p_generation_id IS NULL OR p_document_id IS NULL OR p_form_code IS NULL
     OR p_form_version IS NULL
     OR p_form_version !~ v_version_pattern
     OR NOT public.form_sources_valid(p_sources)
     OR NOT public.form_person_valid(p_person)
     OR p_source_token IS NULL OR p_source_token !~ '^[0-9a-f]{64}$'
     OR p_organisation_sha256 IS NULL OR p_organisation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_confirmed_warnings IS NULL
     OR NOT p_confirmed_warnings <@ '{age_implausible,entry_before_birth,range_reversed,school_qualification_none}'::text[]
     OR (SELECT pg_catalog.count(DISTINCT c) FROM pg_catalog.unnest(p_confirmed_warnings) c)
       <> pg_catalog.cardinality(p_confirmed_warnings)
     OR p_anlage IS NULL OR p_size_bytes IS NULL OR p_size_bytes NOT BETWEEN 1 AND 10485760
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR p_wrapped_key IS NULL OR pg_catalog.octet_length(p_wrapped_key) <> 60 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_form_code::text NOT IN ('tl407', 'kug200b', 'dsv') THEN
    RAISE EXCEPTION 'form_not_supported';
  END IF;
  IF (v_dsv OR v_kug) AND (p_declarations IS NOT NULL
       OR pg_catalog.cardinality(p_confirmed_warnings) > 0 OR p_anlage
       OR NOT public.form_checklist_valid(p_checklist))
     OR v_kug AND (p_employer_sha256 IS NULL OR p_employer_sha256 !~ '^[0-9a-f]{64}$')
     OR v_dsv AND (p_employer_sha256 IS NOT NULL OR p_offer_deadline IS NULL
       OR p_deadline_kind IS NULL)
     OR NOT v_dsv AND (p_offer_deadline IS NOT NULL OR p_deadline_kind IS NOT NULL)
     OR p_batch_size IS NOT NULL AND (NOT v_dsv OR p_batch_size NOT BETWEEN 1 AND 100)
     OR NOT v_dsv AND NOT v_kug AND (p_checklist IS NOT NULL OR p_employer_sha256 IS NOT NULL
       OR NOT public.form_declarations_valid(p_declarations)) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_type := CASE p_form_code::text WHEN 'dsv' THEN 'dsv_form' WHEN 'kug200b' THEN 'kug200b_form'
    ELSE 'tl407_form' END;
  pol := public.current_document_policy(v_type::public.document_type);
  IF v_dsv THEN
    PERFORM public.assert_context(p_context, p_participation_id, '{user}');
    IF (p_context).on_behalf_of IS NOT NULL THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    -- A bulk generation (1 to 100 DSV, one transaction, all or nothing) takes the project's
    -- exclusive lock before any participation row (lock order, ADR-0002); the calls of one batch
    -- run in participation id order. The shared lock `lock_participation` takes follows.
    IF p_batch_size IS NOT NULL THEN
      SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
      IF v_project_id IS NULL THEN RAISE EXCEPTION 'participation_not_found'; END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project_id));
    END IF;
    r := public.lock_participation(p_participation_id);
    IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id)
       && '{project_lead,back_office}'::text[] THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    SELECT * INTO pj FROM public.project WHERE id = r.project_id;
    SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
    v_tg_start := coalesce(r.tg_start, w.default_tg_start);
    IF r.dsv_status::text = 'dsv_offered' THEN
      RAISE EXCEPTION 'dsv_offer_open';
    END IF;
    IF pj.type <> 'ta_tg' OR pj.status <> 'active'
       OR r.status IN ('withdrawn', 'ta_completed', 'exited') OR w.id IS NULL
       OR v_tg_start IS NULL OR coalesce(r.tg_end, w.default_tg_end) IS NULL
       OR r.dsv_status::text NOT IN ('not_offered', 'dsv_declined', 'dsv_expired')
       OR pj.dsv_template_version IS NULL THEN
      RAISE EXCEPTION 'dsv_not_generatable';
    END IF;
    IF pj.dsv_template_version <> p_form_version THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    IF p_deadline_kind::text = 'wave' AND r.dsv_status::text <> 'not_offered' THEN
      RAISE EXCEPTION 'offer_deadline_invalid';
    END IF;
    IF p_deadline_kind::text = 'wave'
       AND w.signing_deadline IS DISTINCT FROM p_offer_deadline THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    IF w.latest_entry_date IS NULL OR p_offer_deadline < v_today
       OR p_offer_deadline > w.latest_entry_date OR p_offer_deadline > v_tg_start THEN
      RAISE EXCEPTION 'offer_deadline_invalid';
    END IF;
  ELSIF v_kug THEN
    r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  ELSE
    r := public.lock_profiler(p_participation_id, p_context);
  END IF;
  SELECT revision INTO v_profile FROM public.participant_profile WHERE participation_id = r.id;
  SELECT * INTO pr FROM public.participant_profiling WHERE participation_id = r.id;
  SELECT revision INTO v_assessment FROM public.participant_profiling_assessment
  WHERE participation_id = r.id;
  SELECT unemployment_revision INTO v_unemployment FROM public.participant_residence_social_data
  WHERE participation_id = r.id;
  IF coalesce(v_profile, 0) <> (p_sources ->> 'profile')::integer
     OR public.form_person(r.id) IS DISTINCT FROM p_person
     OR v_dsv AND public.dsv_source_token(r.id, p_organisation_sha256)
       IS DISTINCT FROM p_source_token
     OR v_kug AND (SELECT pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(p.customer_name, 'UTF8')), 'hex')
       FROM public.project p WHERE p.id = r.project_id) IS DISTINCT FROM p_employer_sha256
     OR NOT v_kug AND NOT v_dsv AND (coalesce(pr.revision, 0) <> (p_sources ->> 'profiling')::integer
       OR coalesce(v_assessment, 0) <> (p_sources ->> 'assessment')::integer
       OR coalesce(v_unemployment, 0) <> (p_sources ->> 'unemployment')::integer
       OR pr.jobboerse_choice::text IS DISTINCT FROM p_declarations ->> 'jobboerseChoice'
       OR pr.ba_contact_consent IS DISTINCT FROM
         (p_declarations ->> 'baContactConsent')::boolean) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf)
  VALUES (p_document_id, r.project_id, r.id, pol.type, pol.catalog_version,
    pol.retention_class, 'application/pdf', p_size_bytes, p_content_sha256, NULL, p_key_id,
    p_wrapped_key, 'user', (p_context).staff_user_id, false);
  INSERT INTO public.form_generation (id, project_id, participation_id, document_id, form_code,
    form_version, profile_revision, profiling_revision, assessment_revision,
    unemployment_revision, source_token, organisation_sha256, jobboerse_choice,
    ba_contact_consent, confirmed_warnings, anlage, checklist, offer_deadline, deadline_kind,
    generated_by)
  VALUES (p_generation_id, r.project_id, r.id, p_document_id, p_form_code, p_form_version,
    (p_sources ->> 'profile')::integer, (p_sources ->> 'profiling')::integer,
    (p_sources ->> 'assessment')::integer, (p_sources ->> 'unemployment')::integer,
    p_source_token, p_organisation_sha256,
    CASE WHEN NOT v_kug AND NOT v_dsv THEN pr.jobboerse_choice END,
    CASE WHEN NOT v_kug AND NOT v_dsv THEN pr.ba_contact_consent END,
    p_confirmed_warnings, p_anlage, p_checklist, p_offer_deadline, p_deadline_kind,
    (p_context).staff_user_id);
  IF v_dsv THEN
    PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_form_generated', p_context, NULL,
      NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_document_id,
        'templateVersion', p_form_version, 'deadlineKind', p_deadline_kind) ||
        CASE WHEN p_batch_size IS NULL THEN '{}'::jsonb
          ELSE pg_catalog.jsonb_build_object('batchSize', p_batch_size) END, false);
    RETURN p_generation_id;
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'form_generated', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_document_id,
      'formCode', p_form_code, 'formVersion', p_form_version, 'anlage', p_anlage), false);
  FOREACH v_code IN ARRAY p_confirmed_warnings LOOP
    PERFORM public.write_audit_event(r.project_id, r.id, 'warning_confirmed', p_context, NULL,
      NULL, NULL, v_code, NULL, '{}'::jsonb, false);
  END LOOP;
  RETURN p_generation_id;
END $function$;

ALTER FUNCTION public.record_form_generation(public.audit_context,uuid,uuid,uuid,public.form_code,text,jsonb,jsonb,text,text,jsonb,text[],boolean,integer,text,text,bytea,jsonb,text,date,public.dsv_deadline_kind,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_form_generation(public.audit_context,uuid,uuid,uuid,public.form_code,text,jsonb,jsonb,text,text,jsonb,text[],boolean,integer,text,text,bytea,jsonb,text,date,public.dsv_deadline_kind,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_form_generation(public.audit_context,uuid,uuid,uuid,public.form_code,text,jsonb,jsonb,text,text,jsonb,text[],boolean,integer,text,text,bytea,jsonb,text,date,public.dsv_deadline_kind,integer) TO transfer_app;
