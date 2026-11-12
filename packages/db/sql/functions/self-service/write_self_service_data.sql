CREATE OR REPLACE FUNCTION public.write_self_service_data(p_participation_id uuid, p_context public.audit_context, p_page text, p_values jsonb, p_revision integer, p_notice_version text, p_token_hash text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  prof public.participant_profile;
  d public.participant_details;
  v_has_profile boolean;
  v_has_details boolean;
  v_revision integer;
  v_keys text[];
  v_fields text[] := '{}';
  v_contact text[] := '{}';
  v_address jsonb;
  v_custom jsonb;
  v_licence public.driving_licence_class[];
  n public.participant_profile;
  k text;
BEGIN
  IF p_values IS NULL OR pg_catalog.jsonb_typeof(p_values) <> 'object' OR p_revision IS NULL
     OR p_revision < 0 OR p_notice_version IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_keys := CASE p_page
    WHEN 'personal' THEN '{gender,maritalStatus}'
    WHEN 'contact' THEN '{address,phone,mobile,privateEmail}'
    WHEN 'education' THEN '{educationHistory}'
    WHEN 'work_history' THEN '{workHistory}'
    WHEN 'languages_mobility' THEN '{languageSkills,drivingLicence,vehicleAvailable}'
    WHEN 'job_wish' THEN
      '{workingTimePreferences,jobWishes,desiredWorkLocations,maxCommuteDistance,earliestStartDate}'
    WHEN 'further' THEN '{}'
  END::text[];
  IF v_keys IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Only the page's keys; on `further` only custom keys with a scalar or null value.
  IF EXISTS (
    SELECT FROM pg_catalog.jsonb_each(p_values) e
    WHERE CASE WHEN p_page = 'further'
      THEN e.key !~ '^custom\.[a-z][a-z0-9_]{0,62}$'
        OR pg_catalog.jsonb_typeof(e.value) NOT IN ('string', 'number', 'boolean', 'null')
      ELSE NOT e.key = ANY (v_keys) END) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  r := public.lock_self_service_writer(p_participation_id, p_context, p_token_hash);
  IF NOT EXISTS (SELECT FROM public.self_service_notice_acknowledgement
                 WHERE participation_id = r.id AND notice_version = p_notice_version) THEN
    RAISE EXCEPTION 'notice_required';
  END IF;
  SELECT * INTO prof FROM public.participant_profile WHERE participation_id = r.id FOR UPDATE;
  v_has_profile := FOUND;
  v_revision := coalesce(prof.revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  n := prof;

  BEGIN
    IF p_page = 'contact' THEN
      SELECT * INTO d FROM public.participant_details WHERE participation_id = r.id FOR UPDATE;
      v_has_details := FOUND;
      v_address := nullif(p_values -> 'address', 'null'::jsonb);
      IF v_address IS NOT NULL AND pg_catalog.jsonb_typeof(v_address) <> 'object' THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
      SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}') INTO v_contact
      FROM (VALUES
        (1, 'address', ROW(d.address_street, d.address_postal_code, d.address_city,
          d.address_country) IS DISTINCT FROM ROW(v_address ->> 'street',
          v_address ->> 'postalCode', v_address ->> 'city', v_address ->> 'country')),
        (2, 'phone', d.phone IS DISTINCT FROM p_values ->> 'phone'),
        (3, 'mobile', d.mobile IS DISTINCT FROM p_values ->> 'mobile'),
        (4, 'privateEmail', d.private_email IS DISTINCT FROM p_values ->> 'privateEmail')
      ) AS c(ord, field, changed)
      WHERE c.changed;
      v_fields := v_contact;
      IF pg_catalog.cardinality(v_contact) > 0 AND NOT v_has_details THEN
        INSERT INTO public.participant_details (participation_id, project_id)
        VALUES (r.id, r.project_id);
      END IF;
      IF pg_catalog.cardinality(v_contact) > 0 THEN
        UPDATE public.participant_details
        SET address_street = v_address ->> 'street',
            address_postal_code = v_address ->> 'postalCode',
            address_city = v_address ->> 'city',
            address_country = v_address ->> 'country',
            phone = p_values ->> 'phone', mobile = p_values ->> 'mobile',
            private_email = p_values ->> 'privateEmail',
            participant_maintained = ARRAY(
              SELECT f FROM pg_catalog.unnest(ARRAY['address', 'phone', 'mobile', 'privateEmail'])
                WITH ORDINALITY AS a(f, ord)
              WHERE f = ANY (participant_maintained || v_contact) ORDER BY ord),
            participant_address_written_at = CASE WHEN 'address' = ANY (v_contact) THEN now()
              ELSE participant_address_written_at END,
            updated_at = now()
        WHERE participation_id = r.id;
      END IF;
    ELSIF p_page = 'personal' THEN
      n.gender := (p_values ->> 'gender')::public.gender;
      n.marital_status := (p_values ->> 'maritalStatus')::public.marital_status;
    ELSIF p_page = 'education' THEN
      n.education_history := nullif(p_values -> 'educationHistory', 'null'::jsonb);
    ELSIF p_page = 'work_history' THEN
      n.work_history := nullif(p_values -> 'workHistory', 'null'::jsonb);
    ELSIF p_page = 'languages_mobility' THEN
      n.language_skills := nullif(p_values -> 'languageSkills', 'null'::jsonb);
      -- "none" is the answer "no licence", stored as an empty array (TL 407 field 42).
      v_licence := CASE pg_catalog.jsonb_typeof(p_values -> 'drivingLicence')
        WHEN 'array' THEN ARRAY(SELECT pg_catalog.jsonb_array_elements_text(
          p_values -> 'drivingLicence')::public.driving_licence_class)
        WHEN 'string' THEN CASE WHEN p_values ->> 'drivingLicence' = 'none'
          THEN '{}'::public.driving_licence_class[] END
      END;
      IF pg_catalog.jsonb_typeof(p_values -> 'drivingLicence') NOT IN ('null', 'array')
         AND v_licence IS NULL THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
      n.driving_licence := v_licence;
      n.vehicle_available := (p_values ->> 'vehicleAvailable')::boolean;
    ELSIF p_page = 'job_wish' THEN
      n.working_time_preferences := nullif(p_values -> 'workingTimePreferences', 'null'::jsonb);
      n.job_wishes := nullif(p_values -> 'jobWishes', 'null'::jsonb);
      n.desired_work_locations := p_values ->> 'desiredWorkLocations';
      n.max_commute_distance := nullif(p_values -> 'maxCommuteDistance', 'null'::jsonb);
      -- ISO only: the cast alone would read other date styles.
      IF p_values ->> 'earliestStartDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
      n.earliest_start_date := (p_values ->> 'earliestStartDate')::date;
    ELSE
      -- `further`: the given custom fields replace theirs; another chain's stay stored.
      v_custom := coalesce(prof.custom_fields, '{}'::jsonb);
      FOR k IN SELECT e.key FROM pg_catalog.jsonb_each(p_values) e ORDER BY e.key LOOP
        IF (v_custom -> k) IS DISTINCT FROM nullif(p_values -> k, 'null'::jsonb) THEN
          v_fields := v_fields || k;
        END IF;
        v_custom := CASE WHEN p_values -> k = 'null'::jsonb THEN v_custom - k
          ELSE v_custom || pg_catalog.jsonb_build_object(k, p_values -> k) END;
      END LOOP;
      n.custom_fields := v_custom;
    END IF;

    IF p_page NOT IN ('contact', 'further') THEN
      SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}') INTO v_fields
      FROM (VALUES
        (1, 'gender', prof.gender IS DISTINCT FROM n.gender),
        (2, 'maritalStatus', prof.marital_status IS DISTINCT FROM n.marital_status),
        (3, 'educationHistory', prof.education_history IS DISTINCT FROM n.education_history),
        (4, 'workHistory', prof.work_history IS DISTINCT FROM n.work_history),
        (5, 'languageSkills', prof.language_skills IS DISTINCT FROM n.language_skills),
        (6, 'drivingLicence', prof.driving_licence IS DISTINCT FROM n.driving_licence),
        (7, 'vehicleAvailable', prof.vehicle_available IS DISTINCT FROM n.vehicle_available),
        (8, 'workingTimePreferences',
          prof.working_time_preferences IS DISTINCT FROM n.working_time_preferences),
        (9, 'jobWishes', prof.job_wishes IS DISTINCT FROM n.job_wishes),
        (10, 'desiredWorkLocations',
          prof.desired_work_locations IS DISTINCT FROM n.desired_work_locations),
        (11, 'maxCommuteDistance', prof.max_commute_distance IS DISTINCT FROM n.max_commute_distance),
        (12, 'earliestStartDate', prof.earliest_start_date IS DISTINCT FROM n.earliest_start_date)
      ) AS c(ord, field, changed)
      WHERE c.changed;
    END IF;
    IF pg_catalog.cardinality(v_fields) = 0 THEN
      RETURN v_revision;
    END IF;

    IF NOT v_has_profile THEN
      INSERT INTO public.participant_profile (participation_id, project_id, revision)
      VALUES (r.id, r.project_id, 1);
    END IF;
    UPDATE public.participant_profile
    SET gender = n.gender, marital_status = n.marital_status,
        education_history = n.education_history, work_history = n.work_history,
        language_skills = n.language_skills, driving_licence = n.driving_licence,
        vehicle_available = n.vehicle_available,
        working_time_preferences = n.working_time_preferences, job_wishes = n.job_wishes,
        desired_work_locations = n.desired_work_locations,
        max_commute_distance = n.max_commute_distance, earliest_start_date = n.earliest_start_date,
        custom_fields = coalesce(n.custom_fields, '{}'::jsonb),
        revision = v_revision + 1, updated_at = now()
    WHERE participation_id = r.id;
  EXCEPTION
    -- Stable codes, never the offending value (a cast's or a table's message would carry it).
    WHEN check_violation OR invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow OR invalid_parameter_value OR not_null_violation THEN
      RAISE EXCEPTION 'invalid_argument';
  END;
  PERFORM public.write_audit_event(r.project_id, r.id, 'participant_data_changed', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields)),
    false);
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_self_service_data(uuid,public.audit_context,text,jsonb,integer,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_self_service_data(uuid,public.audit_context,text,jsonb,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_self_service_data(uuid,public.audit_context,text,jsonb,integer,text,text) TO transfer_app;
