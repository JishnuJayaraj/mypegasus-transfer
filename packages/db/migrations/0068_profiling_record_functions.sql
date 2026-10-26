-- Hand-written (ADR-0002, the profiling record; data-protection.md, the profiling record;
-- process-and-lifecycle.md, the profiling record; Q85, Q192, Q193): the profiling sessions, the
-- pending declarations to the BA, section C with p. 7 and the unemployment period, the history's
-- projection rows and the grants. Same hardening as 0066: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. Audit details carry ids, codes and dates only. The event types 0067 added are compared as
-- text here, since this runs after them in the same migration run.
--
-- Encryption as in 0050 (ADR-0002, field encryption): `pgp_sym_encrypt` with the key the API
-- passes per call, the envelope binding each value to its participation and field key, the row's
-- `key_id`; a row written under another key is `key_unknown`.
--
-- Lock order (ADR-0002): the project's advisory lock shared through `lock_participation`, the
-- participation row, the profiling rows (the record, then its sessions), then the sensitive rows.
-- Only the participation's assigned consultant writes, as themselves in normal mode; assisted mode
-- and break-glass grant nothing here. A terminal participation takes no writes
-- (`participation_closed`), like the self-service data.

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
    'assisted_mode_started', 'assisted_mode_ended', 'document_added', 'document_reviewed',
    'document_deleted', 'document_upload_rejected', 'reminder_queued', 'reminder_delivery',
    'audit_history_opened', 'appointment_booked', 'appointment_booking_cancelled',
    'attendance_recorded', 'attendance_superseded', 'information_delivery_confirmed',
    'attendance_conflict_escalated', 'attendance_conflict_resolved',
    'appointment_notice_followed_up', 'missed_appointment_resolved', 'profiling_session_changed',
    'profiling_declarations_recorded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a session by its id and date,
-- the declarations by their keys, both in the `profiling` stream.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('profiling_session_changed', NULL, 'profiling', false, false, '{action,sessionId,date}'),
  ('profiling_declarations_recorded', NULL, 'profiling', false, false, '{fields}');
--> statement-breakpoint

-- Internal helpers (no grant).

-- The participation's assigned consultant writes (data-protection.md, the profiling record): a
-- staff user acting for themselves (`actor_not_allowed` in assisted mode or for anyone else), an
-- active account, the consultant role in the project and an open assignment
-- (`document_staff_roles`). Locks the participation (the shared project lock first) and refuses a
-- terminal one. Returns the locked participation.
CREATE FUNCTION lock_profiler(p_participation_id uuid, p_context audit_context)
RETURNS participation LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation;
BEGIN
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF NOT 'consultant' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- Whether the staff user may read the profiler's data now: the assigned consultant as themselves
-- (data-protection.md, access matrix; the API decides with the matrix first).
CREATE FUNCTION profiler_may_read(p_participation_id uuid, p_context audit_context)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL
    AND 'consultant' = ANY (public.document_staff_roles(p_participation_id,
      (p_context).staff_user_id))
$$;
--> statement-breakpoint

-- The Berlin date (process-and-lifecycle.md, dates): no profiling session after it.
CREATE FUNCTION berlin_today()
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date
$$;
--> statement-breakpoint

-- An ISO date string that is a real calendar date (the domain's `isoDate`).
CREATE FUNCTION iso_date_valid(v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN pg_catalog.jsonb_typeof(v) = 'string' AND v #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND pg_catalog.to_char((v #>> '{}')::date, 'YYYY-MM-DD') = v #>> '{}';
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
--> statement-breakpoint

-- The structure of a whole session list (the domain's `ProfilingSessionsInput`): at most 50
-- objects of an optional uuid `id`, a real `date` and the times `hh:mm`. The rules between them
-- are checked by the caller with their own codes.
CREATE FUNCTION profiling_sessions_valid(p_sessions jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.jsonb_typeof(p_sessions) = 'array'
    AND pg_catalog.jsonb_array_length(p_sessions) <= 50
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e(s)
      WHERE NOT (pg_catalog.jsonb_typeof(s) = 'object'
        AND (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k)
          <@ '{date,from,id,to}'::text[]
        AND s ? 'date' AND s ? 'from' AND s ? 'to'
        AND public.iso_date_valid(s -> 'date')
        AND pg_catalog.jsonb_typeof(s -> 'from') = 'string'
        AND s ->> 'from' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND pg_catalog.jsonb_typeof(s -> 'to') = 'string'
        AND s ->> 'to' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND (NOT s ? 'id' OR pg_catalog.jsonb_typeof(s -> 'id') = 'string'
          AND s ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
$$;
--> statement-breakpoint

-- Trimmed text of 1 to `p_max` characters without control characters, or JSON null.
CREATE FUNCTION profiling_text_valid(v jsonb, p_max integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT v IS NOT NULL AND (v = 'null'::jsonb OR pg_catalog.jsonb_typeof(v) = 'string'
    AND pg_catalog.char_length(v #>> '{}') BETWEEN 1 AND p_max
    AND v #>> '{}' = pg_catalog.btrim(v #>> '{}') AND v #>> '{}' !~ '[[:cntrl:]]')
$$;
--> statement-breakpoint

-- A page 7 narrative (the domain's `multilineText`): trimmed (no leading or trailing white space,
-- line breaks included), 1 to `p_max` characters, line breaks as `\n` only and no other control
-- character; or JSON null.
CREATE FUNCTION profiling_multiline_valid(v jsonb, p_max integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT v IS NOT NULL AND (v = 'null'::jsonb OR pg_catalog.jsonb_typeof(v) = 'string'
    AND pg_catalog.char_length(v #>> '{}') BETWEEN 1 AND p_max
    AND v #>> '{}' !~ '^[[:space:]]' AND v #>> '{}' !~ '[[:space:]]$'
    AND pg_catalog.replace(v #>> '{}', E'\n', '') !~ '[[:cntrl:]]')
$$;
--> statement-breakpoint

-- A section C rating, or JSON null.
CREATE FUNCTION profiling_rating_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT v IS NOT NULL AND (v = 'null'::jsonb OR v #>> '{}' IN ('no_need', 'placement_relevant')
    AND pg_catalog.jsonb_typeof(v) = 'string')
$$;
--> statement-breakpoint

-- The section C lines with a rating and a text, in the form's order (the domain's
-- `assessmentLines`), and the "andere" lines among them, which name what they rate.
CREATE FUNCTION profiling_assessment_lines()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{schoolQualification,vocationalQualification,workExperience,languageSkills,otherQualification,intellectualCapacity,workAndSocialBehaviour,otherPerformance,initiative,learningReadiness,otherMotivation,localMobility,otherConditions}'::text[]
$$;
--> statement-breakpoint
CREATE FUNCTION profiling_other_lines()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{otherQualification,otherPerformance,otherMotivation,otherConditions}'::text[]
$$;
--> statement-breakpoint

-- The structure of a whole assessment (the domain's `ProfilingAssessment`): every line an object
-- of exactly its keys (a rating, a text of at most 300 characters, an "andere" line's label of at
-- most 100), the health line `{rating}` only, Gesamteinschätzung and weiteres Vorgehen at most
-- 2,000 characters each with their line breaks; nothing else.
CREATE FUNCTION profiling_assessment_valid(p_values jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.jsonb_typeof(p_values) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values) k ORDER BY k)
      = ARRAY(SELECT k FROM pg_catalog.unnest(public.profiling_assessment_lines()
          || '{health,overallAssessment,nextSteps}'::text[]) k ORDER BY k)
    AND NOT EXISTS (
      SELECT FROM pg_catalog.unnest(public.profiling_assessment_lines()) l
      WHERE NOT (pg_catalog.jsonb_typeof(p_values -> l) = 'object'
        AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values -> l) k ORDER BY k)
          = CASE WHEN l = ANY (public.profiling_other_lines()) THEN '{label,rating,text}'::text[]
                 ELSE '{rating,text}'::text[] END
        AND public.profiling_rating_valid(p_values -> l -> 'rating')
        AND public.profiling_text_valid(p_values -> l -> 'text', 300)
        AND (NOT l = ANY (public.profiling_other_lines())
          OR public.profiling_text_valid(p_values -> l -> 'label', 100))))
    AND pg_catalog.jsonb_typeof(p_values -> 'health') = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_values -> 'health') k) = '{rating}'
    AND public.profiling_rating_valid(p_values -> 'health' -> 'rating')
    AND public.profiling_multiline_valid(p_values -> 'overallAssessment', 2000)
    AND public.profiling_multiline_valid(p_values -> 'nextSteps', 2000)
$$;
--> statement-breakpoint

-- A whole assessment as its stored fields, keyed as audited (the domain's `assessmentFieldKeys`):
-- a line as its object, NULL when it is empty (no rating, text or label); p. 7's texts; the
-- health line's rating.
CREATE FUNCTION profiling_assessment_fields(p_values jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (
    SELECT pg_catalog.jsonb_object_agg('profilingAssessment.' || l,
      CASE WHEN EXISTS (SELECT FROM pg_catalog.jsonb_each(p_values -> l) e(k, v)
                        WHERE v <> 'null'::jsonb)
           THEN p_values -> l ELSE 'null'::jsonb END)
    FROM pg_catalog.unnest(public.profiling_assessment_lines()) l)
    || pg_catalog.jsonb_build_object(
      'overallAssessment', p_values -> 'overallAssessment',
      'nextSteps', p_values -> 'nextSteps',
      'profilingHealthAssessment', p_values -> 'health' -> 'rating')
$$;
--> statement-breakpoint

-- The stored fields as the whole assessment again: an empty line has every value null.
CREATE FUNCTION profiling_assessment_values(p_fields jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
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
$$;
--> statement-breakpoint

-- The stored assessment, decrypted, as its fields (keys with JSON null where nothing is stored)
-- and its revision (0 before the first write). A row written under another key is `key_unknown`.
CREATE FUNCTION open_profiling_assessment(p_participation_id uuid, p_key text, p_key_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- The profiling sessions written whole (process-and-lifecycle.md, the profiling record; Q193):
-- `p_sessions` holds every session, an existing one with its `id` (`session_not_found` for an id
-- not of this participation), a new one without. `bis` after `von`, no date after today in
-- Berlin (`session_in_future`), no two of one day overlapping (`sessions_overlap`), no id twice
-- (`invalid_argument`). `p_revision` must be the record's (`stale_revision`, 0 before the first
-- write). Each session added, changed or removed is audited `profiling_session_changed` with its
-- id and date (a removed one's last date); a write that changes nothing writes nothing and returns
-- the revision unchanged, otherwise the record's revision is bumped and returned.
CREATE FUNCTION write_profiling_sessions(
  p_participation_id uuid, p_context audit_context, p_sessions jsonb, p_revision integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_revision integer;
  v_has_record boolean;
  v_changed boolean := false;
  v_session public.profiling_session;
  v_entry jsonb;
  v_id uuid;
BEGIN
  IF p_sessions IS NULL OR NOT public.profiling_sessions_valid(p_sessions)
     OR p_revision IS NULL OR p_revision < 0
     OR (SELECT pg_catalog.count(e ->> 'id') <> pg_catalog.count(DISTINCT e ->> 'id')
         FROM pg_catalog.jsonb_array_elements(p_sessions) e) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
             WHERE e ->> 'from' >= e ->> 'to') THEN
    RAISE EXCEPTION 'session_times_reversed';
  END IF;

  r := public.lock_profiler(p_participation_id, p_context);
  SELECT revision INTO v_revision FROM public.participant_profiling
  WHERE participation_id = r.id FOR UPDATE;
  v_has_record := FOUND;
  v_revision := coalesce(v_revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
             WHERE (e ->> 'date')::date > public.berlin_today()) THEN
    RAISE EXCEPTION 'session_in_future';
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY a(s, i)
    JOIN pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY b(s, i)
      ON a.i < b.i AND a.s ->> 'date' = b.s ->> 'date'
    WHERE a.s ->> 'from' < b.s ->> 'to' AND b.s ->> 'from' < a.s ->> 'to') THEN
    RAISE EXCEPTION 'sessions_overlap';
  END IF;

  PERFORM FROM public.profiling_session WHERE participation_id = r.id ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
    WHERE e ? 'id' AND NOT EXISTS (SELECT FROM public.profiling_session x
                                   WHERE x.id = (e ->> 'id')::uuid AND x.participation_id = r.id))
  THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- Removed: the stored sessions the list doesn't name.
  FOR v_session IN SELECT * FROM public.profiling_session x WHERE x.participation_id = r.id
             AND NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
                             WHERE e ->> 'id' = x.id::text)
           ORDER BY x.session_date, x.time_from, x.id LOOP
    DELETE FROM public.profiling_session WHERE id = v_session.id;
    PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action', 'removed',
        'sessionId', v_session.id, 'date', v_session.session_date), false);
    v_changed := true;
  END LOOP;
  -- Changed and added, in the list's order.
  FOR v_entry IN SELECT x FROM pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY u(x, i)
           ORDER BY i LOOP
    IF v_entry ? 'id' THEN
      v_id := (v_entry ->> 'id')::uuid;
      UPDATE public.profiling_session SET session_date = (v_entry ->> 'date')::date,
        time_from = v_entry ->> 'from', time_to = v_entry ->> 'to',
        recorded_by = (p_context).staff_user_id, recorded_at = pg_catalog.now()
      WHERE id = v_id AND (session_date, time_from, time_to)
        IS DISTINCT FROM ((v_entry ->> 'date')::date, v_entry ->> 'from', v_entry ->> 'to');
      IF FOUND THEN
        PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed',
          p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action',
            'changed', 'sessionId', v_id, 'date', v_entry ->> 'date'), false);
        v_changed := true;
      END IF;
    ELSE
      v_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.profiling_session (id, project_id, participation_id, session_date,
        time_from, time_to, recorded_by)
      VALUES (v_id, r.project_id, r.id, (v_entry ->> 'date')::date, v_entry ->> 'from', v_entry ->> 'to',
        (p_context).staff_user_id);
      PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed', p_context,
        NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action', 'added',
          'sessionId', v_id, 'date', v_entry ->> 'date'), false);
      v_changed := true;
    END IF;
  END LOOP;
  IF NOT v_changed THEN
    RETURN v_revision;
  END IF;

  IF v_has_record THEN
    UPDATE public.participant_profiling SET revision = v_revision + 1, updated_at = pg_catalog.now()
    WHERE participation_id = r.id;
  ELSE
    INSERT INTO public.participant_profiling (participation_id, project_id, revision)
    VALUES (r.id, r.project_id, 1);
  END IF;
  RETURN v_revision + 1;
END $$;
--> statement-breakpoint

-- The pending declarations to the BA (ba-forms.md, declarations; Q44, Q193): the Jobbörse choice
-- and the BA contact declaration, each `null` while undecided; never the portal consent, never a
-- signed form's record. `p_revision` as for the sessions. The changed keys are audited
-- `profiling_declarations_recorded`, never their values; who recorded them last and when is kept.
-- Returns the revision.
CREATE FUNCTION write_profiling_declarations(
  p_participation_id uuid, p_context audit_context, p_jobboerse_choice jobboerse_choice,
  p_ba_contact_consent boolean, p_revision integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  x public.participant_profiling;
  v_revision integer;
  v_fields text[] := '{}';
BEGIN
  IF p_revision IS NULL OR p_revision < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_profiler(p_participation_id, p_context);
  SELECT * INTO x FROM public.participant_profiling WHERE participation_id = r.id FOR UPDATE;
  v_revision := coalesce(x.revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF x.jobboerse_choice IS DISTINCT FROM p_jobboerse_choice THEN
    v_fields := v_fields || 'jobboerseChoice'::text;
  END IF;
  IF x.ba_contact_consent IS DISTINCT FROM p_ba_contact_consent THEN
    v_fields := v_fields || 'baContactConsent'::text;
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RETURN v_revision;
  END IF;
  INSERT INTO public.participant_profiling (participation_id, project_id, jobboerse_choice,
    ba_contact_consent, declarations_recorded_by, declarations_recorded_at, revision)
  VALUES (r.id, r.project_id, p_jobboerse_choice, p_ba_contact_consent,
    (p_context).staff_user_id, pg_catalog.now(), 1)
  ON CONFLICT (participation_id) DO UPDATE SET jobboerse_choice = EXCLUDED.jobboerse_choice,
    ba_contact_consent = EXCLUDED.ba_contact_consent,
    declarations_recorded_by = EXCLUDED.declarations_recorded_by,
    declarations_recorded_at = EXCLUDED.declarations_recorded_at,
    revision = v_revision + 1, updated_at = pg_catalog.now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_declarations_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', v_fields),
    false);
  RETURN v_revision + 1;
END $$;
--> statement-breakpoint

-- Section C and p. 7 written whole (data-protection.md, the profiling record; Q192): every line,
-- the health line's rating, Gesamteinschätzung and weiteres Vorgehen (`profiling_assessment_valid`;
-- any key on the health line but its rating is `health_detail_not_recorded`: no health narrative
-- is stored). `p_revision` must be the assessment's (`stale_revision`, 0 before the first write).
-- The changed fields are found by decrypting the stored ones; each is audited `sensitive_write`
-- with its key, never a value; nothing changed writes nothing. Both tables are then written
-- whole under the current key. Returns the revision.
CREATE FUNCTION write_profiling_assessment(
  p_participation_id uuid, p_context audit_context, p_values jsonb, p_revision integer,
  p_key text, p_key_id text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Section C and p. 7 decrypted for the assigned consultant (data-protection.md, access matrix;
-- Q49): the whole assessment and its revision; each field's read is audited `sensitive_read` with
-- its key, so no read skips the log. Anyone else is `actor_not_allowed`.
CREATE FUNCTION read_profiling_assessment(
  p_participation_id uuid, p_context audit_context, p_key text, p_key_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project_id uuid;
  v_old jsonb;
  v_field text;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT public.profiler_may_read(p_participation_id, p_context) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_old := public.open_profiling_assessment(p_participation_id, p_key, p_key_id);
  FOR v_field IN SELECT f FROM pg_catalog.jsonb_object_keys(v_old -> 'fields') f ORDER BY f LOOP
    PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read',
      p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', v_field),
      false);
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('revision', v_old -> 'revision',
    'values', public.profiling_assessment_values(v_old -> 'fields'));
END $$;
--> statement-breakpoint

-- Whether the staff user may read the unemployment period now: like the other residence and
-- social answers in normal mode (data-protection.md, access matrix): the assigned consultant or
-- back office of the project, as themselves.
CREATE FUNCTION unemployment_reader(p_participation_id uuid, p_context audit_context)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL
    AND public.document_staff_roles(p_participation_id, (p_context).staff_user_id)
      && '{consultant,back_office}'::text[]
$$;
--> statement-breakpoint

-- "arbeitslos seit / bis" (TL 407 fields 34, 35; Q85 open, fail safe: highly confidential,
-- `residence_social`) recorded by the assigned consultant beside the residence and social answers:
-- `{from, until}` (real dates, `until` null while open; a reversed range is the form's warning,
-- not a refusal) or `null` to clear it, with the revision its read returned (`stale_revision`,
-- clearing included; 0 before the first write). The other answers of the row stay as they are; a
-- row written under another key is `key_unknown`. Audited `sensitive_write` with the key
-- `unemploymentPeriod`; nothing changed writes nothing. Returns the revision of what is stored.
CREATE FUNCTION write_unemployment_period(
  p_participation_id uuid, p_context audit_context, p_period jsonb, p_revision integer,
  p_key text, p_key_id text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  rs public.participant_residence_social_data;
  v_period jsonb := nullif(p_period, 'null'::jsonb);
  v_revision integer;
BEGIN
  IF p_revision IS NULL OR p_revision < 0
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR v_period IS NOT NULL AND NOT (pg_catalog.jsonb_typeof(v_period) = 'object'
       AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(v_period) k ORDER BY k)
         = '{from,until}'::text[]
       AND public.iso_date_valid(v_period -> 'from')
       AND (v_period -> 'until' = 'null'::jsonb OR public.iso_date_valid(v_period -> 'until')))
  THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_profiler(p_participation_id, p_context);
  SELECT * INTO rs FROM public.participant_residence_social_data WHERE participation_id = r.id
  FOR UPDATE;
  v_revision := coalesce(rs.unemployment_revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF rs.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  IF public.open_sensitive_value(r.id, 'unemploymentPeriod', rs.unemployment_period, p_key)
     IS NOT DISTINCT FROM v_period THEN
    RETURN v_revision;
  END IF;
  INSERT INTO public.participant_residence_social_data (participation_id, project_id,
    unemployment_period, unemployment_period_present, unemployment_revision, key_id)
  VALUES (r.id, r.project_id,
    public.seal_sensitive_value(r.id, 'unemploymentPeriod', v_period, p_key),
    v_period IS NOT NULL, v_revision + 1, p_key_id)
  ON CONFLICT (participation_id) DO UPDATE SET unemployment_period = EXCLUDED.unemployment_period,
    unemployment_period_present = EXCLUDED.unemployment_period_present,
    unemployment_revision = EXCLUDED.unemployment_revision,
    key_id = EXCLUDED.key_id, written_at = pg_catalog.now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'unemploymentPeriod'), false);
  RETURN v_revision + 1;
END $$;
--> statement-breakpoint

-- The unemployment period decrypted with its revision, both from one row read, for the assigned
-- consultant or back office in normal mode (`actor_not_allowed` otherwise); the read is audited
-- `sensitive_read` with the key `unemploymentPeriod`. Returns `{revision, period}`.
CREATE FUNCTION read_unemployment_period(
  p_participation_id uuid, p_context audit_context, p_key text, p_key_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project_id uuid;
  rs public.participant_residence_social_data;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT public.unemployment_reader(p_participation_id, p_context) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO rs FROM public.participant_residence_social_data
  WHERE participation_id = p_participation_id;
  IF rs.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'unemploymentPeriod'),
    false);
  RETURN pg_catalog.jsonb_build_object('revision', coalesce(rs.unemployment_revision, 0),
    'period', coalesce(public.open_sensitive_value(p_participation_id, 'unemploymentPeriod',
      rs.unemployment_period, p_key), 'null'::jsonb));
END $$;
--> statement-breakpoint

-- Replaced: the profiling record's events are written only by its functions too.
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
      'step_up_failed', 'assisted_mode_started', 'assisted_mode_ended', 'document_opened',
      'document_added', 'document_reviewed', 'document_deleted', 'document_upload_rejected',
      'reminder_queued', 'reminder_delivery', 'audit_history_opened', 'appointment_created',
      'appointment_changed', 'appointment_cancelled', 'appointment_booked',
      'appointment_booking_cancelled', 'attendance_recorded', 'attendance_superseded',
      'information_delivery_confirmed', 'attendance_conflict_escalated',
      'attendance_conflict_resolved', 'appointment_notice_followed_up',
      'missed_appointment_resolved', 'profiling_session_changed',
      'profiling_declarations_recorded') THEN
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

-- Grants: transfer_app selects the record and the sessions, and of the encrypted tables the keys,
-- presence flags, key ids, revision and times, never a ciphertext column; no INSERT, UPDATE or
-- DELETE. It executes the six functions; the helpers stay internal.
GRANT SELECT ON TABLE participant_profiling, profiling_session TO transfer_app;
--> statement-breakpoint
GRANT SELECT (participation_id, project_id, school_qualification_present,
  vocational_qualification_present, work_experience_present, language_skills_present,
  other_qualification_present, intellectual_capacity_present, work_and_social_behaviour_present,
  other_performance_present, initiative_present, learning_readiness_present,
  other_motivation_present, local_mobility_present, other_conditions_present,
  overall_assessment_present, next_steps_present, key_id, created_at, written_at, revision)
  ON TABLE participant_profiling_assessment TO transfer_app;
--> statement-breakpoint
GRANT SELECT (participation_id, project_id, health_rating_present, key_id, created_at,
  written_at) ON TABLE participant_profiling_health_assessment TO transfer_app;
--> statement-breakpoint
GRANT SELECT (unemployment_period_present, unemployment_revision)
  ON TABLE participant_residence_social_data TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_profiler, profiler_may_read, berlin_today, iso_date_valid,
  profiling_sessions_valid, profiling_text_valid, profiling_rating_valid,
  profiling_multiline_valid, profiling_assessment_lines, profiling_other_lines,
  profiling_assessment_valid, unemployment_reader,
  profiling_assessment_fields, profiling_assessment_values, open_profiling_assessment,
  write_profiling_sessions, write_profiling_declarations, write_profiling_assessment,
  read_profiling_assessment, write_unemployment_period, read_unemployment_period FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION write_profiling_sessions, write_profiling_declarations,
  write_profiling_assessment, read_profiling_assessment, write_unemployment_period,
  read_unemployment_period TO transfer_app;
