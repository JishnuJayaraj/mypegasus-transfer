-- Hand-written (ADR-0002, encryption; data-protection.md, self-service; Q135, Q137): the encrypted
-- highly confidential and special-category self-service fields and the participant's step-up.
-- Same hardening as 0048: SECURITY DEFINER owned by transfer_owner, a fixed search_path with
-- pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app, database
-- time, refusals as P0001 with a stable code, never a value.
--
-- Encryption: pgcrypto's `pgp_sym_encrypt` with AES-256 (no compression), inside these functions
-- only. The API derives the key (HKDF `field-encryption:v1` from FIELD_ENCRYPTION_KEY) and passes
-- it as a bind parameter per call, never `set_config`; `key_id` is its fingerprint, so a value
-- written under another key is refused rather than misread. The plaintext is an envelope of the
-- participation id, the field key and the value; a ciphertext moved to another row or field fails
-- the envelope check. pgcrypto lives in its own schema `crypto`, which transfer_app can't use.

CREATE SCHEMA crypto;
--> statement-breakpoint
CREATE EXTENSION pgcrypto WITH SCHEMA crypto;
--> statement-breakpoint

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
    'self_service_notice_acknowledged', 'step_up_completed', 'step_up_failed'));
--> statement-breakpoint

-- Internal helpers (no grant).

-- The fields of a sensitive group (packages/domain/src/self-service/sensitive.ts).
CREATE FUNCTION sensitive_group_fields(p_group text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_group
    WHEN 'ba_details' THEN
      '{pensionInsuranceNumber,nationality,entryToGermanyDate,residenceStatus,buergergeld}'::text[]
    WHEN 'health' THEN '{healthRestrictions,severeDisability}'::text[]
  END
$$;
--> statement-breakpoint

-- Encrypts one value in its envelope; NULL stays NULL.
CREATE FUNCTION seal_sensitive_value(
  p_participation_id uuid, p_field text, p_value jsonb, p_key text
) RETURNS bytea LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_value IS NULL OR p_value = 'null'::jsonb THEN NULL
    ELSE crypto.pgp_sym_encrypt(pg_catalog.jsonb_build_object('p', p_participation_id,
      'f', p_field, 'v', p_value)::text, p_key, 'cipher-algo=aes256, compress-algo=0') END
$$;
--> statement-breakpoint

-- Decrypts one value and checks its envelope: another participation or field is
-- `envelope_mismatch`, a wrong key or a damaged ciphertext `decryption_failed` (pgcrypto's own
-- message is dropped).
CREATE FUNCTION open_sensitive_value(
  p_participation_id uuid, p_field text, p_ciphertext bytea, p_key text
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF p_ciphertext IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v := crypto.pgp_sym_decrypt(p_ciphertext, p_key)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'decryption_failed';
  END;
  IF pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object'
     OR v ->> 'p' IS DISTINCT FROM p_participation_id::text
     OR v ->> 'f' IS DISTINCT FROM p_field OR NOT v ? 'v' THEN
    RAISE EXCEPTION 'envelope_mismatch';
  END IF;
  RETURN v -> 'v';
END $$;
--> statement-breakpoint

-- The stored values of a participation's sensitive fields, decrypted, as one object (keys with
-- NULL where nothing is stored). A row written under another key is `key_unknown`.
CREATE FUNCTION open_sensitive_fields(p_participation_id uuid, p_key text, p_key_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i public.participant_identifier_data;
  rs public.participant_residence_social_data;
  h public.participant_health_data;
BEGIN
  SELECT * INTO i FROM public.participant_identifier_data WHERE participation_id = p_participation_id;
  SELECT * INTO rs FROM public.participant_residence_social_data
  WHERE participation_id = p_participation_id;
  SELECT * INTO h FROM public.participant_health_data WHERE participation_id = p_participation_id;
  IF i.key_id <> p_key_id OR rs.key_id <> p_key_id OR h.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'pensionInsuranceNumber', public.open_sensitive_value(p_participation_id,
      'pensionInsuranceNumber', i.pension_insurance_number, p_key),
    'nationality', public.open_sensitive_value(p_participation_id, 'nationality',
      rs.nationality, p_key),
    'entryToGermanyDate', public.open_sensitive_value(p_participation_id, 'entryToGermanyDate',
      rs.entry_to_germany_date, p_key),
    'residenceStatus', public.open_sensitive_value(p_participation_id, 'residenceStatus',
      rs.residence_status, p_key),
    'buergergeld', public.open_sensitive_value(p_participation_id, 'buergergeld',
      rs.buergergeld, p_key),
    'healthRestrictions', public.open_sensitive_value(p_participation_id, 'healthRestrictions',
      h.health_restrictions, p_key),
    'severeDisability', public.open_sensitive_value(p_participation_id, 'severeDisability',
      h.severe_disability, p_key));
END $$;
--> statement-breakpoint

-- The structure of a sensitive value (the API validates it with the domain's schemas first):
-- NULL is empty.
CREATE FUNCTION sensitive_value_valid(p_field text, v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF v IS NULL OR v = 'null'::jsonb THEN RETURN true; END IF;
  RETURN CASE p_field
    WHEN 'pensionInsuranceNumber' THEN pg_catalog.jsonb_typeof(v) = 'string'
      AND v #>> '{}' ~ '^[0-9]{8}[A-Z][0-9]{3}$'
    WHEN 'nationality' THEN v = '{"kind": "german"}'::jsonb OR (
      pg_catalog.jsonb_typeof(v) = 'object' AND v ->> 'kind' = 'other'
      AND v ->> 'country' ~ '^[A-Z]{2}$' AND v ->> 'country' <> 'DE'
      AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v)) = 2)
    WHEN 'entryToGermanyDate' THEN pg_catalog.jsonb_typeof(v) = 'string'
      AND v #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND pg_catalog.to_char((v #>> '{}')::date, 'YYYY-MM-DD') = v #>> '{}'
    WHEN 'residenceStatus' THEN v #>> '{}' IN ('blue_card', 'residence_permit', 'visa',
      'settlement_permit', 'permission_to_reside', 'toleration')
      AND pg_catalog.jsonb_typeof(v) = 'string'
    WHEN 'buergergeld' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    WHEN 'healthRestrictions' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    WHEN 'severeDisability' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    ELSE false
  END;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
--> statement-breakpoint

-- Q137: whether a session has stepped up before special-category data: its own step-up, or, for
-- an account assured by birth date, the session that follows an activation (or recovery) with
-- the birth-date step. A login code never counts.
CREATE FUNCTION participant_session_stepped_up(s participant_session)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.sensitive_step_up_at IS NOT NULL OR s.step_up_method = 'birth_date' AND EXISTS (
    SELECT FROM public.participant_account a
    WHERE a.participation_id = s.participation_id AND a.identity_assurance = 'birth_date')
$$;
--> statement-breakpoint

-- Q137: how the account steps up: birth date, or a step-up code for a photo-ID account.
CREATE FUNCTION participant_step_up_method(p_participation_id uuid)
RETURNS sensitive_step_up_method LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE a.identity_assurance WHEN 'birth_date' THEN 'birth_date'
    ELSE 'photo_id_and_code' END::public.sensitive_step_up_method
  FROM public.participant_account a WHERE a.participation_id = p_participation_id
$$;
--> statement-breakpoint

-- Records the session's step-up, audited as the participant (method, and a code's challenge).
CREATE FUNCTION record_step_up(
  s participant_session, p_method sensitive_step_up_method, p_request_id text,
  p_challenge_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.participant_session SET sensitive_step_up_method = p_method,
    sensitive_step_up_at = now(), last_seen_at = now()
  WHERE token_hash = s.token_hash;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'step_up_completed',
    public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('method', p_method,
      'challengeId', p_challenge_id)), false);
END $$;
--> statement-breakpoint

-- Q137: a wrong birth date counts on the session; the fifth ends it (`step_up_failed`, audited).
-- Returns `mismatch` or `ended`.
CREATE FUNCTION fail_step_up(s participant_session, p_request_id text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.participant_session SET step_up_failures = step_up_failures + 1,
    last_seen_at = now()
  WHERE token_hash = s.token_hash RETURNING step_up_failures INTO n;
  IF n < 5 THEN RETURN 'mismatch'; END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'step_up_failed'
  WHERE token_hash = s.token_hash;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'step_up_failed',
    public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('method', 'birth_date'), false);
  RETURN 'ended';
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- Q137: a birth-date account re-enters its birth date. A match records the step-up (`ok`, also
-- when the session had it already); a wrong date counts (`mismatch`), the fifth ends the session
-- (`ended`). A photo-ID account is `step_not_allowed`. Counted failures are returned, never raised,
-- so the count commits.
CREATE FUNCTION check_step_up_birth_date(p_token_hash text, p_birth_date date, p_request_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; v_birth date;
BEGIN
  IF p_birth_date IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'birth_date' THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF public.participant_session_stepped_up(s) THEN RETURN 'ok'; END IF;
  SELECT birth_date INTO v_birth FROM public.participant_identity
  WHERE participation_id = s.participation_id;
  IF v_birth IS NOT DISTINCT FROM p_birth_date THEN
    PERFORM public.record_step_up(s, 'birth_date', p_request_id);
    RETURN 'ok';
  END IF;
  RETURN public.fail_step_up(s, p_request_id);
END $$;
--> statement-breakpoint

-- Q129, Q137: a step-up code for a photo-ID account to one of its live (verified, not suspended)
-- channels, committed `pending` before the send (ADR-0006); `record_one_time_code_delivery`
-- records the outcome. Refuses a birth-date account or a session that stepped up already
-- (`step_not_allowed`), a channel not the participant's (`channel_not_found`) and the sixth code
-- in an hour per address. Returns the channel's kind and address for the send.
CREATE FUNCTION request_step_up_code(
  p_token_hash text, p_channel_id uuid, p_code_hash text, p_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; ch public.participant_channel;
BEGIN
  IF p_channel_id IS NULL OR p_id IS NULL OR p_code_hash IS NULL
     OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'photo_id_and_code'
     OR public.participant_session_stepped_up(s) THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
    AND suspended_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_not_found'; END IF;
  PERFORM public.insert_one_time_code(s.project_id, s.participation_id, 'step_up', ch.kind,
    ch.address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN pg_catalog.jsonb_build_object('kind', ch.kind, 'address', ch.address);
END $$;
--> statement-breakpoint

-- Q137: the step-up code. A match records the step-up (`ok`); a wrong one counts on the code
-- (`one_time_code_invalid`), its fifth ends it (`one_time_code_exhausted`); the session goes on.
-- Only a code of purpose `step_up` counts, never a login code.
CREATE FUNCTION verify_step_up_code(p_token_hash text, p_code_hash text, p_request_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; v_result text; v_challenge uuid;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  IF public.participant_step_up_method(s.participation_id) <> 'photo_id_and_code' THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF public.participant_session_stepped_up(s) THEN RETURN 'ok'; END IF;
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(s.participation_id,
    'step_up', p_code_hash, p_request_id);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  PERFORM public.record_step_up(s, 'photo_id_and_code', p_request_id, v_challenge);
  RETURN 'ok';
END $$;
--> statement-breakpoint

-- Q135: one sensitive group written whole (the participant; staff in assisted mode join with
-- PR 4a-5). `p_values` holds exactly the group's fields (null for empty); entry date and residence
-- status only with the nationality "other". The writer is checked as for the confidential pages
-- (`lock_self_service_writer`), the health group needs the session's step-up
-- (`step_up_required`), the notice must be acknowledged and `p_revision` must be the profile's,
-- which a write bumps (the wizard's one revision). The changed fields are found by decrypting the
-- stored ones; each is audited as `sensitive_write` with its key, never a value. A table with a
-- changed field is written again whole under the current key. Returns the revision.
CREATE FUNCTION write_sensitive_fields(
  p_participation_id uuid, p_context audit_context, p_group text, p_values jsonb,
  p_revision integer, p_notice_version text, p_key text, p_key_id text,
  p_token_hash text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  s public.participant_session;
  v_keys text[] := public.sensitive_group_fields(p_group);
  v_old jsonb;
  v_changed text[];
  v_revision integer;
  v_has_profile boolean;
  k text;
BEGIN
  IF v_keys IS NULL OR p_values IS NULL OR pg_catalog.jsonb_typeof(p_values) <> 'object'
     OR p_revision IS NULL OR p_revision < 0 OR p_notice_version IS NULL
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR ARRAY(SELECT pg_catalog.jsonb_object_keys(p_values) ORDER BY 1)
       <> ARRAY(SELECT pg_catalog.unnest(v_keys) ORDER BY 1)
     OR EXISTS (SELECT FROM pg_catalog.unnest(v_keys) f
                WHERE NOT public.sensitive_value_valid(f, p_values -> f))
     OR p_group = 'ba_details' AND p_values -> 'nationality' ->> 'kind' IS DISTINCT FROM 'other'
       AND (p_values -> 'entryToGermanyDate' <> 'null'::jsonb
         OR p_values -> 'residenceStatus' <> 'null'::jsonb) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  r := public.lock_self_service_writer(p_participation_id, p_context, p_token_hash);
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
        p_values -> 'pensionInsuranceNumber', p_key),
      p_values -> 'pensionInsuranceNumber' <> 'null'::jsonb, p_key_id)
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
      public.seal_sensitive_value(r.id, 'nationality', p_values -> 'nationality', p_key),
      p_values -> 'nationality' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'entryToGermanyDate', p_values -> 'entryToGermanyDate',
        p_key),
      p_values -> 'entryToGermanyDate' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'residenceStatus', p_values -> 'residenceStatus', p_key),
      p_values -> 'residenceStatus' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'buergergeld', p_values -> 'buergergeld', p_key),
      p_values -> 'buergergeld' <> 'null'::jsonb, p_key_id)
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
      public.seal_sensitive_value(r.id, 'healthRestrictions', p_values -> 'healthRestrictions',
        p_key),
      p_values -> 'healthRestrictions' <> 'null'::jsonb,
      public.seal_sensitive_value(r.id, 'severeDisability', p_values -> 'severeDisability', p_key),
      p_values -> 'severeDisability' <> 'null'::jsonb, p_key_id)
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
END $$;
--> statement-breakpoint

-- Q135, data-protection.md (access matrix): the decrypted values of `p_keys`, each read audited
-- as `sensitive_read` with its key, so no read skips the log. A participant reads their own
-- through a live active session; the health and disability fields need its step-up
-- (`step_up_required`). Staff read in normal mode: the API decides with the access matrix first;
-- here an active staff user must be the participation's assigned consultant (every field) or back
-- office of its project (all but the health restrictions), else `actor_not_allowed`. Returns an
-- object of the keys, NULL where nothing is stored.
CREATE FUNCTION read_sensitive_fields(
  p_participation_id uuid, p_context audit_context, p_keys text[], p_key text, p_key_id text,
  p_token_hash text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.participant_session;
  v_project_id uuid;
  v_all jsonb;
  v_result jsonb := '{}';
  k text;
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) = 0
     OR NOT p_keys <@ (public.sensitive_group_fields('ba_details')
       || public.sensitive_group_fields('health'))
     OR (SELECT pg_catalog.count(DISTINCT f) FROM pg_catalog.unnest(p_keys) f)
       <> pg_catalog.cardinality(p_keys)
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    IF p_keys && '{healthRestrictions,severeDisability}'
       AND NOT public.participant_session_stepped_up(s) THEN
      RAISE EXCEPTION 'step_up_required';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  ELSIF NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = v_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND u.deactivated_at IS NULL
      AND (m.role = 'back_office' AND NOT 'healthRestrictions' = ANY (p_keys)
        OR m.role = 'consultant' AND EXISTS (
          SELECT FROM public.participant_assignment a
          WHERE a.participation_id = p_participation_id AND a.staff_user_id = m.staff_user_id
            AND a.ended_at IS NULL))) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;

  v_all := public.open_sensitive_fields(p_participation_id, p_key, p_key_id);
  FOREACH k IN ARRAY p_keys LOOP
    v_result := v_result || pg_catalog.jsonb_build_object(k, v_all -> k);
    PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', k), false);
  END LOOP;
  RETURN v_result;
END $$;
--> statement-breakpoint

-- Replaced: the step-up events are written only by their functions too.
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
      'placement_agentur_set', 'self_service_notice_acknowledged', 'step_up_completed',
      'step_up_failed') THEN
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

-- Grants: transfer_app selects the keys, presence flags, key ids and times of the encrypted tables,
-- never a ciphertext column; no INSERT, UPDATE or DELETE. It executes the two field functions and
-- the three step-up functions; pgcrypto stays out of its reach (no USAGE on `crypto`).
GRANT SELECT (participation_id, project_id, pension_insurance_number_present, key_id, created_at,
  written_at) ON TABLE participant_identifier_data TO transfer_app;
--> statement-breakpoint
GRANT SELECT (participation_id, project_id, nationality_present, entry_to_germany_date_present,
  residence_status_present, buergergeld_present, key_id, created_at, written_at)
  ON TABLE participant_residence_social_data TO transfer_app;
--> statement-breakpoint
GRANT SELECT (participation_id, project_id, health_restrictions_present,
  severe_disability_present, key_id, created_at, written_at)
  ON TABLE participant_health_data TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sensitive_group_fields, seal_sensitive_value, open_sensitive_value,
  open_sensitive_fields, sensitive_value_valid, participant_session_stepped_up,
  participant_step_up_method, record_step_up, fail_step_up, check_step_up_birth_date,
  request_step_up_code, verify_step_up_code, write_sensitive_fields, read_sensitive_fields
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION check_step_up_birth_date, request_step_up_code, verify_step_up_code,
  write_sensitive_fields, read_sensitive_fields TO transfer_app;
