-- Hand-written (ADR-0007, assisted mode; data-protection.md, self-service; Q136): assisted mode
-- and the staff writes and reads it allows. Same hardening as 0050: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value.
--
-- An assisted mode is bound to the staff session that opened it (its hash): live while it isn't
-- ended and its session is live. Every assisted call names the session (`p_token_hash`, which for
-- a participant is the portal session's); the functions find the live mode of that session and
-- participation, so a staff user acts on behalf of the participant only through it. The roles are
-- read again here: the PL and back office of the project, the consultant while assigned.

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
    'self_service_notice_acknowledged', 'step_up_completed', 'step_up_failed',
    'assisted_mode_started', 'assisted_mode_ended'));
--> statement-breakpoint

-- Internal helpers (no grant).

-- The roles that let a staff user use assisted mode for a participation now (Q136): PL or back
-- office of its project, consultant while assigned to it; none for a deactivated account.
CREATE FUNCTION assisted_mode_roles(p_participation_id uuid, p_staff_user_id uuid)
RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(
    SELECT DISTINCT m.role::text
    FROM public.participation p
    JOIN public.project_membership m
      ON m.project_id = p.project_id AND m.staff_user_id = p_staff_user_id
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE p.id = p_participation_id
      AND (m.role IN ('project_lead', 'back_office') OR m.role = 'consultant' AND EXISTS (
        SELECT FROM public.participant_assignment a
        WHERE a.participation_id = p.id AND a.staff_user_id = m.staff_user_id
          AND a.ended_at IS NULL))
    ORDER BY 1)
$$;
--> statement-breakpoint

-- The sensitive fields the roles see and write in assisted mode (data-protection.md, access
-- matrix; Q136): the assigned consultant all, the PL health and disability, back office all but
-- health.
CREATE FUNCTION assisted_sensitive_fields(p_roles text[])
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(
    SELECT f FROM pg_catalog.unnest(public.sensitive_group_fields('ba_details')
      || public.sensitive_group_fields('health')) WITH ORDINALITY AS u(f, o)
    WHERE 'consultant' = ANY (p_roles)
      OR 'project_lead' = ANY (p_roles) AND f IN ('healthRestrictions', 'severeDisability')
      OR 'back_office' = ANY (p_roles) AND f <> 'healthRestrictions'
    ORDER BY o)
$$;
--> statement-breakpoint

-- The live assisted mode of the staff session for the participation: the context's staff user on
-- behalf of it (`invalid_actor` otherwise), the mode not ended and its session live
-- (`assisted_mode_required`), a role that may use it now (`actor_not_allowed`). The mode's row is
-- share-locked, so "Beenden" waits for the call. Returns the roles.
CREATE FUNCTION lock_assisted_mode(
  p_participation_id uuid, p_context audit_context, p_staff_session_hash text
) RETURNS text[] LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_roles text[];
BEGIN
  IF (p_context).actor_type IS DISTINCT FROM 'user'
     OR (p_context).on_behalf_of IS DISTINCT FROM p_participation_id THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF p_staff_session_hash IS NULL OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'assisted_mode_required';
  END IF;
  PERFORM FROM public.assisted_mode m
  JOIN public.staff_session s ON s.token_hash = m.staff_session_hash
  WHERE m.staff_session_hash = p_staff_session_hash AND m.participation_id = p_participation_id
    AND m.staff_user_id = (p_context).staff_user_id AND m.ended_at IS NULL
    AND s.ended_at IS NULL AND s.expires_at > now()
  FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assisted_mode_required';
  END IF;
  v_roles := public.assisted_mode_roles(p_participation_id, (p_context).staff_user_id);
  IF pg_catalog.cardinality(v_roles) = 0 THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  RETURN v_roles;
END $$;
--> statement-breakpoint

-- Ends a mode, audited as its staff user's (`assisted_mode_ended` with the reason).
CREATE FUNCTION close_assisted_mode(
  m assisted_mode, p_reason assisted_mode_end_reason, p_request_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.assisted_mode SET ended_at = greatest(now(), m.started_at), end_reason = p_reason
  WHERE id = m.id AND ended_at IS NULL;
  PERFORM public.write_audit_event(m.project_id, m.participation_id, 'assisted_mode_ended',
    ROW('user', m.staff_user_id, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('assistedModeId', m.id,
      'endReason', p_reason), false);
END $$;
--> statement-breakpoint

-- A staff session ends (logout, superseded, deactivation): its assisted modes end with it. An
-- expired session's modes are no longer live; the next start of their staff user closes them.
CREATE FUNCTION end_assisted_modes_of_session()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m public.assisted_mode;
BEGIN
  FOR m IN SELECT * FROM public.assisted_mode
           WHERE staff_session_hash = NEW.token_hash AND ended_at IS NULL ORDER BY started_at
           FOR UPDATE LOOP
    PERFORM public.close_assisted_mode(m, 'staff_session_ended', NULL);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_session_ends_assisted_modes
AFTER UPDATE OF ended_at ON staff_session
FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
EXECUTE FUNCTION end_assisted_modes_of_session();
--> statement-breakpoint

-- Replaced: staff in assisted mode write self-service data too (ADR-0007), through the live mode
-- of their session (`p_token_hash` is then the staff session's hash). Otherwise as in 0048: the
-- participation locked first, refused when terminal (`participation_closed`); a participant only
-- through the live active session of this participation (`session_invalid`, which an
-- `activating` session is too). Returns the locked participation.
CREATE OR REPLACE FUNCTION lock_self_service_writer(
  p_participation_id uuid, p_context audit_context, p_token_hash text
) RETURNS participation LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; s public.participant_session;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF (p_context).actor_type = 'user' THEN
    PERFORM public.lock_assisted_mode(p_participation_id, p_context, p_token_hash);
    RETURN r;
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

-- The functions transfer_app may execute.

-- Q136: a staff user opens assisted mode for a participation after the confirmation (the API
-- requires it), `in_person` or `phone`, bound to their live staff session (`session_invalid`).
-- Refused for a terminal participation (`participation_closed`) and without a role that may use
-- it (`actor_not_allowed`); no activated account is needed (ADR-0007). A mode the session had open
-- for the participation ends first, and so do the staff user's modes of sessions no longer live.
-- Audited as `assisted_mode_started` (how). Returns its id.
CREATE FUNCTION start_assisted_mode(
  p_participation_id uuid, p_context audit_context, p_staff_session_hash text,
  p_how assisted_mode_how, p_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; m public.assisted_mode;
BEGIN
  IF p_how IS NULL OR p_id IS NULL OR p_staff_session_hash IS NULL
     OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_staff_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL
  FOR SHARE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF pg_catalog.cardinality(public.assisted_mode_roles(r.id, (p_context).staff_user_id)) = 0 THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  FOR m IN SELECT a.* FROM public.assisted_mode a
           JOIN public.staff_session s ON s.token_hash = a.staff_session_hash
           WHERE a.staff_user_id = (p_context).staff_user_id AND a.ended_at IS NULL
             AND (a.staff_session_hash = p_staff_session_hash AND a.participation_id = r.id
               OR s.ended_at IS NOT NULL OR s.expires_at <= now())
           ORDER BY a.started_at FOR UPDATE OF a LOOP
    PERFORM public.close_assisted_mode(m, CASE WHEN m.staff_session_hash = p_staff_session_hash
      THEN 'ended' ELSE 'staff_session_ended' END::public.assisted_mode_end_reason,
      (p_context).request_id);
  END LOOP;
  INSERT INTO public.assisted_mode (id, project_id, participation_id, staff_user_id,
    staff_session_hash, how)
  VALUES (p_id, r.project_id, r.id, (p_context).staff_user_id, p_staff_session_hash, p_how);
  PERFORM public.write_audit_event(r.project_id, r.id, 'assisted_mode_started', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('assistedModeId', p_id, 'how', p_how),
    false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- "Beenden": ends the staff session's live mode for the participation, audited
-- (`assisted_mode_ended`, `ended`). Returns whether one was live.
CREATE FUNCTION end_assisted_mode(
  p_participation_id uuid, p_context audit_context, p_staff_session_hash text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m public.assisted_mode;
BEGIN
  IF p_staff_session_hash IS NULL OR p_staff_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO m FROM public.assisted_mode
  WHERE staff_session_hash = p_staff_session_hash AND participation_id = p_participation_id
    AND staff_user_id = (p_context).staff_user_id AND ended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.close_assisted_mode(m, 'ended', (p_context).request_id);
  RETURN true;
END $$;
--> statement-breakpoint

-- Replaced (Q136): staff in assisted mode write the group's fields their roles see there, through
-- the live mode of their session; the fields they don't see keep their values. Otherwise as in
-- 0050: one sensitive group written, the participant's whole. The writer is checked as for the
-- confidential pages (`lock_self_service_writer`), the health group needs the participant
-- session's step-up (`step_up_required`; staff need none), the notice must be acknowledged and
-- `p_revision` must be the profile's, which a write bumps (the wizard's one revision). The changed
-- fields are found by decrypting the stored ones; each is audited as `sensitive_write` with its
-- key, never a value (as actor and `onBehalfOf` in assisted mode). A table with a changed field is
-- written again whole under the current key. Returns the revision.
CREATE OR REPLACE FUNCTION write_sensitive_fields(
  p_participation_id uuid, p_context audit_context, p_group text, p_values jsonb,
  p_revision integer, p_notice_version text, p_key text, p_key_id text,
  p_token_hash text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Replaced (Q136): staff in assisted mode read the fields their roles see there, through the live
-- mode of their session (`p_token_hash`). Otherwise as in 0050 (data-protection.md, access
-- matrix): the decrypted values of `p_keys`, each read audited as `sensitive_read` with its key,
-- so no read skips the log. A participant reads their own through a live active session; the
-- health and disability fields need its step-up (`step_up_required`). Staff read in normal mode:
-- the API decides with the access matrix first; here an active staff user must be the
-- participation's assigned consultant (every field) or back office of its project (all but the
-- health restrictions), else `actor_not_allowed`. Returns an object of the keys, NULL where
-- nothing is stored.
CREATE OR REPLACE FUNCTION read_sensitive_fields(
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
  ELSIF (p_context).on_behalf_of IS NOT NULL THEN
    -- Staff in assisted mode (Q136): the live mode of this staff session, the fields their roles
    -- see there.
    IF NOT p_keys <@ public.assisted_sensitive_fields(
        public.lock_assisted_mode(p_participation_id, p_context, p_token_hash)) THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
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

-- Replaced: the assisted-mode events are written only by their functions too.
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
      'step_up_failed', 'assisted_mode_started', 'assisted_mode_ended') THEN
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

-- Grants: transfer_app selects assisted_mode (the API checks a request's mode) and executes the
-- two functions; no INSERT, UPDATE or DELETE.
GRANT SELECT ON TABLE assisted_mode TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION assisted_mode_roles, assisted_sensitive_fields, lock_assisted_mode,
  close_assisted_mode, end_assisted_modes_of_session, start_assisted_mode, end_assisted_mode
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION start_assisted_mode, end_assisted_mode TO transfer_app;
