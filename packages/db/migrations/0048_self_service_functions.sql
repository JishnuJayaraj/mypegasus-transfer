-- Hand-written (data-protection.md, self-service; Q112, Q138, Q140): the self-service writes of
-- confidential data. Same hardening as 0025 and 0044: SECURITY DEFINER owned by transfer_owner, a
-- fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for
-- transfer_app, database time, refusals as P0001 with a stable code, never a value. The API
-- validates the values with the domain's schemas (packages/domain/src/self-service/values.ts) and
-- the custom fields with the participation's resolved chain first; the functions and the table
-- CHECKs hold the structure. A participant acts only through a live active session of the
-- participation; staff in assisted mode join with their own check (ADR-0007).

ALTER TABLE audit_event DROP CONSTRAINT audit_event_lifecycle_has_participation;
--> statement-breakpoint
ALTER TABLE audit_event ADD CONSTRAINT audit_event_lifecycle_has_participation CHECK (
  participation_id IS NOT NULL OR event_type::text NOT IN (
    'participation_created', 'status_changed', 'entry_wave_assigned',
    'profiling_exception_requested', 'profiling_exception_approved',
    'profiling_exception_rejected', 'profiling_exception_revoked',
    'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed',
    'participation_created_manually', 'participation_dates_changed', 'sensitive_read',
    'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned',
    'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
    'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
    'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
    'one_time_code_exhausted', 'participant_logout', 'participant_login',
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended', 'placement_agentur_set',
    'self_service_notice_acknowledged'));
--> statement-breakpoint

-- An acknowledgement is evidence: never changed or deleted (retention removes it with the
-- personnel file, Slice 7).
CREATE FUNCTION keep_notice_acknowledgement_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'notice_acknowledgement_immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER self_service_notice_acknowledgement_immutable
BEFORE UPDATE OR DELETE ON self_service_notice_acknowledgement
FOR EACH ROW EXECUTE FUNCTION keep_notice_acknowledgement_immutable();
--> statement-breakpoint

-- Who may write self-service data now (data-protection.md, write permissions): the participation locked first, refused when terminal (`participation_closed`); a
-- participant only through the live active session of this participation (`session_invalid`,
-- which an `activating` session is too). The evidence-set phase starts with the retention job
-- (Slice 7); no participation reaches it before. Returns the locked participation.
CREATE FUNCTION lock_self_service_writer(
  p_participation_id uuid, p_context audit_context, p_token_hash text
) RETURNS participation LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; s public.participant_session;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{participant}');
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF s.participation_id <> p_participation_id THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- Q138: the purposes notice acknowledged, once per version: its version and language, who and
-- when. Not a consent. Returns whether this call recorded it (a version acknowledged before is
-- left as it was, and not audited again).
CREATE FUNCTION acknowledge_self_service_notice(
  p_participation_id uuid, p_context audit_context, p_notice_version text,
  p_language notice_language, p_id uuid, p_token_hash text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; v_id uuid;
BEGIN
  IF p_notice_version IS NULL OR p_notice_version !~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'
     OR p_language IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_self_service_writer(p_participation_id, p_context, p_token_hash);
  INSERT INTO public.self_service_notice_acknowledgement (id, project_id, participation_id,
    notice_version, language, actor_type, actor_staff_user_id)
  VALUES (p_id, r.project_id, r.id, p_notice_version, p_language, (p_context).actor_type,
    (p_context).staff_user_id)
  ON CONFLICT (participation_id, notice_version) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'self_service_notice_acknowledged',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
      'acknowledgementId', v_id, 'noticeVersion', p_notice_version, 'language', p_language), false);
  RETURN true;
END $$;
--> statement-breakpoint

-- Q140, Q112: one wizard page written into the real fields (no draft store). `p_values` holds
-- every field of the page (null for empty); nothing else is accepted, so no sensitive field passes.
-- The current purposes notice must be acknowledged (`notice_required`) and `p_revision` must be the
-- profile's (`stale_revision`, 0 before the first write). The changed fields are computed here and
-- audited as `participant_data_changed` with their names, never values; a write that changes
-- nothing writes nothing and returns the revision unchanged, otherwise the revision is bumped and
-- returned. The contact fields go to `participant_details` and become participant-maintained, which
-- the import never overwrites; a written address also notes its time (the placement Agentur hint).
CREATE FUNCTION write_self_service_data(
  p_participation_id uuid, p_context audit_context, p_page text, p_values jsonb,
  p_revision integer, p_notice_version text, p_token_hash text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Replaced (Q112): the import never overwrites a contact field the participant maintains; it
-- skips such a field as if its argument were null (the preview reports the difference by row and
-- target). Otherwise as in 0025.
CREATE OR REPLACE FUNCTION write_participant_data(
  p_participation_id uuid, p_context audit_context,
  p_personnel_number text DEFAULT NULL, p_last_name text DEFAULT NULL, p_first_name text DEFAULT NULL,
  p_birth_date date DEFAULT NULL, p_old_employment_end_date date DEFAULT NULL,
  p_address_street text DEFAULT NULL, p_address_postal_code text DEFAULT NULL,
  p_address_city text DEFAULT NULL, p_address_country text DEFAULT NULL, p_phone text DEFAULT NULL,
  p_mobile text DEFAULT NULL, p_private_email text DEFAULT NULL, p_work_email text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  i public.participant_identity;
  d public.participant_details;
  v_has_identity boolean;
  v_has_details boolean;
  v_fields text[];
  v_kept text[];
BEGIN
  -- The shared project lock, then the row lock: writers of one participation serialise.
  r := public.lock_participation(p_participation_id);
  PERFORM public.assert_context(p_context, p_participation_id, '{user,system}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF pg_catalog.num_nulls(p_address_street, p_address_postal_code, p_address_city,
      p_address_country) NOT IN (0, 4) THEN
    RAISE EXCEPTION 'address_incomplete';
  END IF;
  SELECT * INTO i FROM public.participant_identity WHERE participation_id = p_participation_id;
  v_has_identity := FOUND;
  SELECT * INTO d FROM public.participant_details WHERE participation_id = p_participation_id;
  v_has_details := FOUND;
  IF NOT v_has_identity AND pg_catalog.num_nulls(p_personnel_number, p_last_name, p_first_name) > 0 THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF v_has_identity AND p_personnel_number IS DISTINCT FROM NULL
      AND p_personnel_number IS DISTINCT FROM i.personnel_number THEN
    RAISE EXCEPTION 'personnel_number_immutable';
  END IF;
  -- The participant's own values stay (Q112).
  v_kept := coalesce(d.participant_maintained, '{}');
  IF 'address' = ANY (v_kept) THEN
    p_address_street := NULL; p_address_postal_code := NULL;
    p_address_city := NULL; p_address_country := NULL;
  END IF;
  IF 'phone' = ANY (v_kept) THEN p_phone := NULL; END IF;
  IF 'mobile' = ANY (v_kept) THEN p_mobile := NULL; END IF;
  IF 'privateEmail' = ANY (v_kept) THEN p_private_email := NULL; END IF;

  SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}') INTO v_fields
  FROM (VALUES
    (1, 'personnelNumber', i.personnel_number IS DISTINCT FROM coalesce(p_personnel_number, i.personnel_number)),
    (2, 'lastName', i.last_name IS DISTINCT FROM coalesce(p_last_name, i.last_name)),
    (3, 'firstName', i.first_name IS DISTINCT FROM coalesce(p_first_name, i.first_name)),
    (4, 'birthDate', i.birth_date IS DISTINCT FROM coalesce(p_birth_date, i.birth_date)),
    (5, 'oldEmploymentEndDate', d.old_employment_end_date
      IS DISTINCT FROM coalesce(p_old_employment_end_date, d.old_employment_end_date)),
    (6, 'address', p_address_street IS NOT NULL
      AND ROW(d.address_street, d.address_postal_code, d.address_city, d.address_country)
      IS DISTINCT FROM ROW(p_address_street, p_address_postal_code, p_address_city, p_address_country)),
    (7, 'phone', d.phone IS DISTINCT FROM coalesce(p_phone, d.phone)),
    (8, 'mobile', d.mobile IS DISTINCT FROM coalesce(p_mobile, d.mobile)),
    (9, 'privateEmail', d.private_email IS DISTINCT FROM coalesce(p_private_email, d.private_email)),
    (10, 'workEmail', d.work_email IS DISTINCT FROM coalesce(p_work_email, d.work_email))
  ) AS c(ord, field, changed)
  WHERE c.changed;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF NOT v_has_identity THEN
      INSERT INTO public.participant_identity (participation_id, project_id, personnel_number, last_name,
        first_name, birth_date)
      VALUES (p_participation_id, r.project_id, p_personnel_number, p_last_name, p_first_name, p_birth_date);
    ELSIF v_fields && '{lastName,firstName,birthDate}' THEN
      UPDATE public.participant_identity
      SET last_name = coalesce(p_last_name, last_name), first_name = coalesce(p_first_name, first_name),
          birth_date = coalesce(p_birth_date, birth_date), updated_at = pg_catalog.now()
      WHERE participation_id = p_participation_id;
    END IF;
    IF NOT v_has_details AND v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail}' THEN
      INSERT INTO public.participant_details (participation_id, project_id, address_street,
        address_postal_code, address_city, address_country, phone, mobile, private_email, work_email,
        old_employment_end_date)
      VALUES (p_participation_id, r.project_id, p_address_street, p_address_postal_code, p_address_city,
        p_address_country, p_phone, p_mobile, p_private_email, p_work_email, p_old_employment_end_date);
    ELSIF v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail}' THEN
      UPDATE public.participant_details
      SET address_street = coalesce(p_address_street, address_street),
          address_postal_code = coalesce(p_address_postal_code, address_postal_code),
          address_city = coalesce(p_address_city, address_city),
          address_country = coalesce(p_address_country, address_country),
          phone = coalesce(p_phone, phone), mobile = coalesce(p_mobile, mobile),
          private_email = coalesce(p_private_email, private_email),
          work_email = coalesce(p_work_email, work_email),
          old_employment_end_date = coalesce(p_old_employment_end_date, old_employment_end_date),
          updated_at = pg_catalog.now()
      WHERE participation_id = p_participation_id;
    END IF;
  EXCEPTION
    -- Stable codes, never the offending value (the table's messages would name the constraint).
    WHEN unique_violation THEN
      RAISE EXCEPTION 'personnel_number_taken';
    WHEN check_violation THEN
      RAISE EXCEPTION 'invalid_argument';
  END;
  RETURN public.write_audit_event(r.project_id, p_participation_id, 'participant_data_changed', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields)),
    false);
END $$;
--> statement-breakpoint

-- Replaced: `self_service_notice_acknowledged` is written only by its function too.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed',
      'config_template_pinned', 'config_override_changed', 'rule_relaxation_requested',
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn',
      'project_activated', 'participant_data_changed', 'participation_dates_changed',
      'project_member_added', 'project_member_removed', 'participant_assigned',
      'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
      'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
      'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
      'one_time_code_exhausted', 'participant_logout', 'participant_login',
      'contact_channel_removed', 'consent_ended', 'contact_channels_suspended',
      'placement_agentur_set', 'self_service_notice_acknowledged') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context,
    NULL, NULL, NULL, p_reason_code, p_effective_date, p_details,
    coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

-- Grants: transfer_app selects the new tables and executes the two writers; no INSERT, UPDATE or
-- DELETE on any of them.
GRANT SELECT ON TABLE participant_profile, self_service_notice_acknowledgement TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_self_service_writer, keep_notice_acknowledgement_immutable,
  acknowledge_self_service_notice, write_self_service_data FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acknowledge_self_service_notice, write_self_service_data TO transfer_app;
