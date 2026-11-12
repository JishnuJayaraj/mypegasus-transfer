CREATE OR REPLACE FUNCTION public.write_sensitive_fields(p_participation_id uuid, p_context public.audit_context, p_group text, p_values jsonb, p_revision integer, p_notice_version text, p_key text, p_key_id text, p_token_hash text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  s public.participant_session;
  v_keys text[] := public.sensitive_group_fields(p_group);
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
  v_revision integer;
  v_has_profile boolean;
  k text;
BEGIN
  IF v_keys IS NULL OR p_values IS NULL OR pg_catalog.jsonb_typeof(p_values) <> 'object'
     OR p_revision IS NULL OR p_revision < 0 OR p_notice_version IS NULL
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  r := public.lock_self_service_writer(p_participation_id, p_context, p_token_hash);
  -- Staff in assisted mode write the group's fields their roles see there (Q136), no others.
  IF (p_context).actor_type = 'user' THEN
    v_keys := ARRAY(SELECT f FROM pg_catalog.unnest(v_keys) WITH ORDINALITY AS u(f, o)
      WHERE f = ANY (public.assisted_sensitive_fields(
        public.assisted_mode_roles(r.id, (p_context).staff_user_id)))
      ORDER BY o);
    IF pg_catalog.cardinality(v_keys) = 0 THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
  END IF;
  IF ARRAY(SELECT pg_catalog.jsonb_object_keys(p_values) ORDER BY 1)
       <> ARRAY(SELECT pg_catalog.unnest(v_keys) ORDER BY 1)
     OR EXISTS (SELECT FROM pg_catalog.unnest(v_keys) f
                WHERE NOT public.sensitive_value_valid(f, p_values -> f))
     OR p_group = 'ba_details' AND 'nationality' = ANY (v_keys)
       AND p_values -> 'nationality' ->> 'kind' IS DISTINCT FROM 'other'
       AND (p_values -> 'entryToGermanyDate' <> 'null'::jsonb
         OR p_values -> 'residenceStatus' <> 'null'::jsonb) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_group = 'health' AND (p_context).actor_type = 'participant' THEN
    SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
    IF NOT public.participant_session_stepped_up(s) THEN
      RAISE EXCEPTION 'step_up_required';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT FROM public.self_service_notice_acknowledgement
                 WHERE participation_id = r.id AND notice_version = p_notice_version) THEN
    RAISE EXCEPTION 'notice_required';
  END IF;
  SELECT revision INTO v_revision FROM public.participant_profile
  WHERE participation_id = r.id FOR UPDATE;
  v_has_profile := FOUND;
  v_revision := coalesce(v_revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  PERFORM FROM public.participant_identifier_data WHERE participation_id = r.id FOR UPDATE;
  PERFORM FROM public.participant_residence_social_data WHERE participation_id = r.id FOR UPDATE;
  PERFORM FROM public.participant_health_data WHERE participation_id = r.id FOR UPDATE;
  v_old := public.open_sensitive_fields(r.id, p_key, p_key_id);
  -- The fields not written keep their values (the stored ones are written again whole).
  v_new := v_old || p_values;
  SELECT coalesce(pg_catalog.array_agg(f ORDER BY o), '{}') INTO v_changed
  FROM pg_catalog.unnest(v_keys) WITH ORDINALITY AS u(f, o)
  WHERE nullif(v_old -> f, 'null'::jsonb) IS DISTINCT FROM nullif(p_values -> f, 'null'::jsonb);
  IF pg_catalog.cardinality(v_changed) = 0 THEN
    RETURN v_revision;
  END IF;

  IF v_changed && '{pensionInsuranceNumber}' THEN
    INSERT INTO public.participant_identifier_data (participation_id, project_id,
      pension_insurance_number, pension_insurance_number_present, key_id)
    VALUES (r.id, r.project_id,
      public.seal_sensitive_value(r.id, 'pensionInsuranceNumber',
        v_new -> 'pensionInsuranceNumber', p_key),
      v_new -> 'pensionInsuranceNumber' <> 'null'::jsonb, p_key_id)
    ON CONFLICT (participation_id) DO UPDATE SET
      pension_insurance_number = EXCLUDED.pension_insurance_number,
      pension_insurance_number_present = EXCLUDED.pension_insurance_number_present,
      key_id = EXCLUDED.key_id, written_at = now();
  END IF;
  IF v_changed && '{nationality,entryToGermanyDate,residenceStatus,buergergeld}' THEN
    INSERT INTO public.participant_residence_social_data (participation_id, project_id,
      nationality, nationality_present, entry_to_germany_date, entry_to_germany_date_present,
      residence_status, residence_status_present, buergergeld, buergergeld_present, key_id)
    VALUES (r.id, r.project_id,
      public.seal_sensitive_value(r.id, 'nationality', v_new -> 'nationality', p_key),
      v_new -> 'nationality' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'entryToGermanyDate', v_new -> 'entryToGermanyDate',
        p_key),
      v_new -> 'entryToGermanyDate' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'residenceStatus', v_new -> 'residenceStatus', p_key),
      v_new -> 'residenceStatus' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'buergergeld', v_new -> 'buergergeld', p_key),
      v_new -> 'buergergeld' <> 'null'::jsonb, p_key_id)
    ON CONFLICT (participation_id) DO UPDATE SET
      nationality = EXCLUDED.nationality, nationality_present = EXCLUDED.nationality_present,
      entry_to_germany_date = EXCLUDED.entry_to_germany_date,
      entry_to_germany_date_present = EXCLUDED.entry_to_germany_date_present,
      residence_status = EXCLUDED.residence_status,
      residence_status_present = EXCLUDED.residence_status_present,
      buergergeld = EXCLUDED.buergergeld, buergergeld_present = EXCLUDED.buergergeld_present,
      key_id = EXCLUDED.key_id, written_at = now();
  END IF;
  IF v_changed && '{healthRestrictions,severeDisability}' THEN
    INSERT INTO public.participant_health_data (participation_id, project_id,
      health_restrictions, health_restrictions_present, severe_disability,
      severe_disability_present, key_id)
    VALUES (r.id, r.project_id,
      public.seal_sensitive_value(r.id, 'healthRestrictions', v_new -> 'healthRestrictions',
        p_key),
      v_new -> 'healthRestrictions' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'severeDisability', v_new -> 'severeDisability', p_key),
      v_new -> 'severeDisability' <> 'null'::jsonb, p_key_id)
    ON CONFLICT (participation_id) DO UPDATE SET
      health_restrictions = EXCLUDED.health_restrictions,
      health_restrictions_present = EXCLUDED.health_restrictions_present,
      severe_disability = EXCLUDED.severe_disability,
      severe_disability_present = EXCLUDED.severe_disability_present,
      key_id = EXCLUDED.key_id, written_at = now();
  END IF;

  IF NOT v_has_profile THEN
    INSERT INTO public.participant_profile (participation_id, project_id, revision)
    VALUES (r.id, r.project_id, 1);
  ELSE
    UPDATE public.participant_profile SET revision = v_revision + 1, updated_at = now()
    WHERE participation_id = r.id;
  END IF;
  FOREACH k IN ARRAY v_changed LOOP
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', k), false);
  END LOOP;
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_sensitive_fields(uuid,public.audit_context,text,jsonb,integer,text,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_sensitive_fields(uuid,public.audit_context,text,jsonb,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_sensitive_fields(uuid,public.audit_context,text,jsonb,integer,text,text,text,text) TO transfer_app;
