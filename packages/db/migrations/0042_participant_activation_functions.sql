-- Hand-written (Slice 3 plan, PR 3e; D21–D29): participant activation. Every function is
-- SECURITY DEFINER with a fixed search_path, executable only by transfer_app, uses database time,
-- re-checks its decision under the row locks (participation, then code, then session) and writes
-- its audit events in the same transaction. Failures that must count (a wrong birth date, a wrong
-- delivery address, a wrong one-time code) are returned, never raised, so the count commits.
-- Codes, addresses and hashes never enter an audit row. The limits are portalLimits
-- (packages/domain/src/portal/limits.ts); packages/db/src/portal-limits.int.test.ts holds them.

-- The participant's activation edges (D25); the domain's edge list has them too (drift test).
INSERT INTO "lifecycle_edge" ("track", "from_value", "to_value", "kind", "actors", "project_types") VALUES
  ('main', 'imported', 'contacted', 'activation', '{participant}', null),
  ('main', 'unreachable', 'contacted', 'activation', '{participant}', null);
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
    'one_time_code_exhausted', 'participant_logout'));
--> statement-breakpoint

-- The status body moves into the internal apply_status_change (no grant), unchanged in behaviour
-- but for the activation edge kind, which only complete_activation passes. The granted
-- change_participation_status keeps its signature and still refuses participant actors.
CREATE FUNCTION apply_status_change(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL,
  p_activation boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_type public.project_type;
  v_track public.lifecycle_track;
  v_ending boolean := p_field = 'status' AND p_to IN ('withdrawn', 'exited');
  v_secondary public.end_reason[] := coalesce(p_secondary_reasons, '{}');
  v_signing_deadline date;
  v_event uuid;
  v_request public.profiling_exception_request;
  v_stale public.profiling_exception_superseded_reason;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system,participant}');
  IF p_field IS NULL OR p_to IS NULL OR p_activation IS NULL
     OR p_activation AND p_entry_kind IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (D9, R1, Q98): no transition of a draft project, manual or system. The shared
  -- project lock taken above serialises this with activate_project.
  IF (SELECT status FROM public.project WHERE id = r.project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF p_expected_from IS DISTINCT FROM (CASE p_field
       WHEN 'status' THEN r.status::text
       WHEN 'profiling_status' THEN r.profiling_status::text
       ELSE r.dsv_status::text END) THEN
    RAISE EXCEPTION 'stale_status';
  END IF;

  SELECT type INTO v_type FROM public.project WHERE id = r.project_id;
  SELECT * INTO v_request FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  v_track := CASE p_field WHEN 'status' THEN 'main' WHEN 'profiling_status' THEN 'profiling' ELSE 'dsv' END;
  IF NOT EXISTS (
    SELECT FROM public.lifecycle_edge e
    WHERE e.track = v_track AND e.from_value = p_expected_from AND e.to_value = p_to
      AND (p_context).actor_type = ANY (e.actors)
      AND (e.project_types IS NULL OR v_type = ANY (e.project_types))
      AND (CASE WHEN p_activation THEN e.kind = 'activation'
                WHEN p_entry_kind IS NULL THEN e.kind IN ('manual', 'system')
                ELSE e.kind::text = p_entry_kind::text END)
  ) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  -- Track activity (plan 5.3): the tracks move while `informed` (DSV only in ta_tg); in the TG
  -- with an approved exception, profiling moves forward or is declined (Q74).
  IF v_track = 'dsv' AND NOT (r.status = 'informed' AND v_type = 'ta_tg')
     OR v_track = 'profiling' AND NOT (r.status = 'informed'
       OR r.status = 'active_in_tg' AND v_request.status IS NOT DISTINCT FROM 'approved' AND p_expected_from <> 'profiling_declined') THEN
    RAISE EXCEPTION 'track_inactive';
  END IF;

  IF v_ending THEN
    IF p_end_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required';
    END IF;
    IF NOT public.end_reason_fits(p_to::public.main_status, p_end_reason) THEN
      RAISE EXCEPTION 'reason_wrong_phase';
    END IF;
    -- Special category: not storable until encrypted storage exists (Q66).
    IF 'long_term_illness_reduced_earning_capacity' = ANY (p_end_reason || v_secondary) THEN
      RAISE EXCEPTION 'reason_not_storable';
    END IF;
    IF p_end_reason = ANY (v_secondary)
       OR pg_catalog.cardinality(v_secondary) <> (SELECT pg_catalog.count(DISTINCT s) FROM pg_catalog.unnest(v_secondary) s) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSIF p_end_reason IS NOT NULL OR pg_catalog.cardinality(v_secondary) > 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  -- Round 18: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (round 9), only they.
  IF (p_scheduled_at IS NULL) = coalesce(p_entry_kind IN ('scheduled_entry', 'scheduled_entry_catchup'), false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  IF p_to = 'dsv_offered' THEN
    IF r.entry_wave_id IS NULL THEN
      RAISE EXCEPTION 'wave_required';
    END IF;
    -- The first offer may use the wave's deadline, a re-offer needs its own (Q69); the system
    -- never invents one.
    SELECT signing_deadline INTO v_signing_deadline FROM public.project_entry_wave WHERE id = r.entry_wave_id;
    IF p_offer_deadline IS NULL AND (p_expected_from <> 'not_offered' OR v_signing_deadline IS NULL) THEN
      RAISE EXCEPTION 'offer_deadline_required';
    END IF;
  ELSIF p_offer_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  UPDATE public.participation SET
    status = CASE WHEN p_field = 'status' THEN p_to::public.main_status ELSE status END,
    profiling_status = CASE WHEN p_field = 'profiling_status' THEN p_to::public.profiling_status ELSE profiling_status END,
    dsv_status = CASE WHEN p_field = 'dsv_status' THEN p_to::public.dsv_status ELSE dsv_status END,
    tg_entry_date = CASE WHEN p_to = 'active_in_tg' THEN p_effective_date ELSE tg_entry_date END,
    exit_date = CASE WHEN p_to = 'exited' THEN p_effective_date ELSE exit_date END,
    withdrawn_on = CASE WHEN p_to = 'withdrawn' THEN p_effective_date ELSE withdrawn_on END,
    profiling_done_on = CASE WHEN p_to = 'profiling_done' THEN p_effective_date ELSE profiling_done_on END,
    end_reason = CASE WHEN v_ending THEN p_end_reason ELSE end_reason END,
    end_reason_source = CASE WHEN v_ending THEN (p_context).actor_type ELSE end_reason_source END,
    end_reason_secondary = CASE WHEN v_ending THEN v_secondary ELSE end_reason_secondary END,
    offer_deadline = CASE WHEN p_to = 'dsv_offered' THEN p_offer_deadline ELSE offer_deadline END,
    status_version = status_version + 1
  WHERE id = p_id
  RETURNING * INTO r;

  v_event := public.write_audit_event(r.project_id, p_id, 'status_changed', p_context, p_field,
    p_expected_from, p_to, p_end_reason::text, p_effective_date,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entryKind', p_entry_kind,
      'scheduledAt', pg_catalog.to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'secondaryReasons', CASE WHEN pg_catalog.cardinality(v_secondary) > 0 THEN pg_catalog.to_jsonb(v_secondary) END,
      'offerDeadline', p_offer_deadline)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies (round 10; system-only, round 12), as
  -- system with the same correlation ids (round 16).
  IF v_request.status IS NOT DISTINCT FROM 'requested' THEN
    v_stale := CASE
      WHEN r.status IN ('withdrawn', 'ta_completed', 'exited') THEN 'participation_closed'
      WHEN r.profiling_status IN ('profiling_done', 'profiling_declined') THEN 'profiling_closed'
    END;
    IF v_stale IS NOT NULL THEN
      UPDATE public.profiling_exception_request
      SET status = 'superseded', superseded_reason = v_stale
      WHERE id = v_request.id;
      PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_superseded',
        ROW('system', NULL, NULL, 'lifecycle.supersede-stale-exception', NULL,
            (p_context).request_id, (p_context).job_id)::public.audit_context,
        NULL, NULL, NULL, v_stale::text, NULL,
        pg_catalog.jsonb_build_object('profilingExceptionRequestId', v_request.id, 'statusChangeId', v_event), false);
    END IF;
  END IF;
  RETURN v_event;
END $$;
--> statement-breakpoint

-- One track moves one step (compare-and-set on `p_expected_from`), with its dependent columns and
-- exactly one status_changed event. Staff and system only: the participant's activation edges
-- are taken by complete_activation alone (D25). Returns the status_changed event's id.
CREATE OR REPLACE FUNCTION change_participation_status(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system}');
  RETURN public.apply_status_change(p_id, p_field, p_expected_from, p_to, p_context, p_entry_kind,
    p_end_reason, p_secondary_reasons, p_offer_deadline, p_effective_date, p_scheduled_at, false);
END $$;
--> statement-breakpoint

-- Internal helpers (no grant).

-- A participant's own context (D25): actor `participant`, never on behalf of anyone.
CREATE FUNCTION participant_context(p_participation_id uuid, p_request_id text)
RETURNS audit_context LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ROW('participant', NULL, p_participation_id, NULL, NULL, p_request_id, NULL)::public.audit_context
$$;
--> statement-breakpoint

-- What the system records about portal activations (a lock, an exhausted one-time code).
CREATE FUNCTION portal_system_context(p_request_id text)
RETURNS audit_context LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ROW('system', NULL, NULL, 'portal-activation', NULL, p_request_id, NULL)::public.audit_context
$$;
--> statement-breakpoint

-- D29: 30 minutes idle, 12 hours absolute, by database time (portalLimits.session).
CREATE FUNCTION participant_session_live(s participant_session)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.ended_at IS NULL AND s.last_seen_at > now() - interval '30 minutes'
    AND s.created_at > now() - interval '12 hours'
$$;
--> statement-breakpoint

-- D14, D15: an activation code that can still be used. A sheet only after its handover; a failed
-- in-person delivery is revoked anyway, a pending or unknown one stays valid (D20).
CREATE FUNCTION activation_code_open(c activation_code)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.purpose = 'activation' AND c.revoked_at IS NULL AND c.locked_at IS NULL
    AND c.used_at IS NULL AND c.expires_at > now()
    AND (c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL)
    AND (c.channel <> 'in_person' OR c.delivery_status IN ('pending', 'sent', 'unknown'))
$$;
--> statement-breakpoint

-- Q121: a status before admission needs the cutoff of its wave not to have passed (Berlin date).
CREATE FUNCTION participation_before_cutoff(p participation)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.status NOT IN ('imported', 'contacted', 'unreachable') OR NOT EXISTS (
    SELECT FROM public.project_entry_wave w
    WHERE w.id = p.entry_wave_id AND w.latest_entry_date IS NOT NULL
      AND (now() AT TIME ZONE 'Europe/Berlin')::date > w.latest_entry_date)
$$;
--> statement-breakpoint

-- Q129: only a handed-over sheet or an in-person code without a birth date skip the check.
CREATE FUNCTION activation_needs_birth_date(c activation_code)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.channel = 'letter' OR EXISTS (
    SELECT FROM public.participant_identity i
    WHERE i.participation_id = c.participation_id AND i.birth_date IS NOT NULL)
$$;
--> statement-breakpoint

-- A normalised private address (packages/domain/src/portal/contact.ts), as the channel CHECK.
CREATE FUNCTION contact_address_valid(p_kind contact_channel_kind, p_address text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(CASE p_kind
    WHEN 'email' THEN p_address ~ '^[^@[:space:]A-Z]+@[^@[:space:]A-Z]+[.][^@[:space:]A-Z]+$'
      AND length(p_address) <= 254
    ELSE p_address ~ '^[+][1-9][0-9]{7,14}$' END, false)
$$;
--> statement-breakpoint

-- D28: a channel is a private address that isn't the imported work email and belongs to no other
-- active account; a collision is the generic `channel_in_use`, never naming the other account.
CREATE FUNCTION assert_channel_available(
  p_participation_id uuid, p_kind contact_channel_kind, p_address text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.contact_address_valid(p_kind, p_address) OR p_kind = 'email' AND EXISTS (
    SELECT FROM public.participant_details d
    WHERE d.participation_id = p_participation_id AND lower(d.work_email) = p_address) THEN
    RAISE EXCEPTION 'channel_invalid';
  END IF;
  IF EXISTS (SELECT FROM public.participant_channel ch
             WHERE ch.kind = p_kind AND ch.address = p_address AND ch.removed_at IS NULL) THEN
    RAISE EXCEPTION 'channel_in_use';
  END IF;
END $$;
--> statement-breakpoint

-- The live activating session of `p_token_hash`, its code locked first, then the session (the lock
-- order of every activation function: participation, code, session); the code must be open.
CREATE FUNCTION lock_activating_session(p_token_hash text)
RETURNS participant_session LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; c public.activation_code;
BEGIN
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
  IF NOT FOUND OR s.state <> 'activating' THEN RAISE EXCEPTION 'session_invalid'; END IF;
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id FOR UPDATE;
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT public.participant_session_live(s) THEN RAISE EXCEPTION 'session_invalid'; END IF;
  IF NOT public.activation_code_open(c) THEN RAISE EXCEPTION 'code_invalid'; END IF;
  RETURN s;
END $$;
--> statement-breakpoint

-- D14: one failure on an open code; the fifth locks it atomically under the code's row lock, ends
-- its activating sessions and is recorded by the system. Returns `mismatch` or `locked`.
CREATE FUNCTION count_activation_failure(p_activation_code_id uuid, p_request_id text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.activation_code;
BEGIN
  UPDATE public.activation_code SET failed_attempts = failed_attempts + 1,
    locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN now() END
  WHERE id = p_activation_code_id RETURNING * INTO c;
  IF c.locked_at IS NULL THEN RETURN 'mismatch'; END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'code_closed'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_locked',
    public.portal_system_context(p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('activationCodeId', c.id), false);
  RETURN 'locked';
END $$;
--> statement-breakpoint

-- D27: a one-time code to an address. A per-address transaction lock serialises the hourly count
-- of login and verification codes together (5 per hour); a new code supersedes the participation's
-- earlier open ones of the same purpose.
CREATE FUNCTION insert_one_time_code(
  p_project_id uuid, p_participation_id uuid, p_purpose one_time_code_purpose,
  p_kind contact_channel_kind, p_address text, p_code_hash text, p_id uuid
) RETURNS one_time_code_challenge LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE made public.one_time_code_challenge;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('one-time-code:' || p_kind::text || ':' || p_address, 0));
  IF (SELECT pg_catalog.count(*) FROM public.one_time_code_challenge
      WHERE kind = p_kind AND address = p_address AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  UPDATE public.one_time_code_challenge SET invalidated_at = now(), invalidation_reason = 'superseded'
  WHERE participation_id = p_participation_id AND purpose = p_purpose
    AND consumed_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO public.one_time_code_challenge (
    id, project_id, participation_id, purpose, kind, address, code_hash, expires_at)
  VALUES (p_id, p_project_id, p_participation_id, p_purpose, p_kind, p_address, p_code_hash,
    now() + interval '15 minutes')
  RETURNING * INTO made;
  RETURN made;
END $$;
--> statement-breakpoint

-- D27: checks a one-time code against the participation's live code of `p_purpose`. A match
-- consumes it (`ok`); a wrong entry counts (`mismatch`), the fifth ends it (`exhausted`, recorded
-- by the system); no live code is `none`.
CREATE FUNCTION verify_one_time_code(
  p_participation_id uuid, p_purpose one_time_code_purpose, p_code_hash text, p_request_id text,
  OUT result text, OUT challenge_id uuid
) LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE challenge public.one_time_code_challenge;
BEGIN
  SELECT * INTO challenge FROM public.one_time_code_challenge
  WHERE participation_id = p_participation_id AND purpose = p_purpose AND consumed_at IS NULL
    AND invalidated_at IS NULL AND expires_at > now() AND failed_attempts < 5
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN result := 'none'; RETURN; END IF;
  challenge_id := challenge.id;
  IF challenge.code_hash = p_code_hash THEN
    UPDATE public.one_time_code_challenge SET consumed_at = now() WHERE id = challenge.id
    RETURNING * INTO challenge;
    result := 'ok';
    RETURN;
  END IF;
  UPDATE public.one_time_code_challenge SET failed_attempts = failed_attempts + 1
  WHERE id = challenge.id RETURNING * INTO challenge;
  IF challenge.failed_attempts < 5 THEN result := 'mismatch'; RETURN; END IF;
  PERFORM public.write_audit_event(challenge.project_id, challenge.participation_id,
    'one_time_code_exhausted', public.portal_system_context(p_request_id), NULL, NULL, NULL, NULL,
    NULL, pg_catalog.jsonb_build_object('challengeId', challenge.id, 'purpose', challenge.purpose),
    false);
  result := 'exhausted';
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- D22, D23: a submitted code starts an `activating` session. An unknown, expired, revoked, used,
-- locked, not handed-over or already activated code returns NULL (the one generic answer) and
-- counts nothing; a valid code past the cutoff refuses `before_cutoff` (D25). A new session of
-- the same code supersedes the earlier one.
CREATE FUNCTION start_activation(p_code_hash text, p_token_hash text, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.activation_code; p public.participation;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO c FROM public.activation_code WHERE code_hash = p_code_hash;
  IF NOT FOUND THEN RETURN NULL; END IF;
  p := public.lock_participation(c.participation_id);
  SELECT * INTO c FROM public.activation_code WHERE id = c.id FOR UPDATE;
  IF NOT public.activation_code_open(c) OR p.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT status FROM public.project WHERE id = p.project_id) <> 'active'
     OR EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id) THEN
    RETURN NULL;
  END IF;
  IF NOT public.participation_before_cutoff(p) THEN RAISE EXCEPTION 'before_cutoff'; END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'superseded'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  INSERT INTO public.participant_session (token_hash, project_id, participation_id, state, activation_code_id)
  VALUES (p_token_hash, p.project_id, p.id, 'activating', c.id);
  RETURN pg_catalog.jsonb_build_object('channel', c.channel, 'deliveryKind', c.delivery_kind,
    'language', c.notice_language, 'needsBirthDate', public.activation_needs_birth_date(c));
END $$;
--> statement-breakpoint

-- D14, D23: the birth-date step. A match records it on the session (also as its step-up, D29);
-- a well-formed wrong date counts on the code: `ok`, `mismatch` or `locked`.
CREATE FUNCTION check_activation_birth_date(p_token_hash text, p_birth_date date, p_request_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; c public.activation_code; v_birth date;
BEGIN
  IF p_birth_date IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF s.birth_date_checked_at IS NOT NULL OR NOT public.activation_needs_birth_date(c) THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  SELECT birth_date INTO v_birth FROM public.participant_identity
  WHERE participation_id = s.participation_id;
  IF v_birth IS NOT DISTINCT FROM p_birth_date THEN
    UPDATE public.participant_session SET birth_date_checked_at = now(), last_seen_at = now(),
      step_up_method = 'birth_date', step_up_at = now()
    WHERE token_hash = s.token_hash;
    RETURN 'ok';
  END IF;
  RETURN public.count_activation_failure(c.id, p_request_id);
END $$;
--> statement-breakpoint

-- D14, D23: for an `in_person` code, the address the link came to, retyped (its keyed hash). A
-- match with the link's possession verifies that channel; a mismatch counts on the code.
CREATE FUNCTION check_activation_delivery_address(
  p_token_hash text, p_address_hash text, p_request_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; c public.activation_code;
BEGIN
  IF p_address_hash IS NULL OR p_address_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF c.channel <> 'in_person' OR s.delivery_address_checked_at IS NOT NULL
     OR public.activation_needs_birth_date(c) AND s.birth_date_checked_at IS NULL THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  IF p_address_hash = c.delivery_address_hash THEN
    UPDATE public.participant_session SET delivery_address_checked_at = now(), last_seen_at = now()
    WHERE token_hash = s.token_hash;
    RETURN 'ok';
  END IF;
  RETURN public.count_activation_failure(c.id, p_request_id);
END $$;
--> statement-breakpoint

-- D23, D27: a one-time code for the private email or mobile the participant chose, committed
-- `pending` before the send (D20). Refuses an in-person code, a missing birth-date step, an
-- invalid or taken address and the sixth code in an hour per address. Returns the expiry.
CREATE FUNCTION create_one_time_code(
  p_token_hash text, p_kind contact_channel_kind, p_address text, p_code_hash text, p_id uuid
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; c public.activation_code; made public.one_time_code_challenge;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL OR p_id IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF c.channel = 'in_person'
     OR public.activation_needs_birth_date(c) AND s.birth_date_checked_at IS NULL THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  PERFORM public.assert_channel_available(s.participation_id, p_kind, p_address);
  made := public.insert_one_time_code(s.project_id, s.participation_id, 'channel_verification',
    p_kind, p_address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN made.expires_at;
END $$;
--> statement-breakpoint

-- D20: the outcome of a one-time code's send, recorded after it. A definitive failure invalidates
-- the code, unless a newer one already superseded it during the send; an unknown outcome stays
-- valid. Only the session whose participation it belongs to records it.
CREATE FUNCTION record_one_time_code_delivery(
  p_token_hash text, p_challenge_id uuid, p_outcome activation_delivery_status
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ch public.one_time_code_challenge;
BEGIN
  SELECT * INTO ch FROM public.one_time_code_challenge WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT FROM public.participant_session s
    WHERE s.token_hash = p_token_hash AND s.participation_id = ch.participation_id) THEN
    RAISE EXCEPTION 'challenge_not_found';
  END IF;
  IF ch.delivery_status <> 'pending' OR p_outcome NOT IN ('sent', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid_delivery_state';
  END IF;
  UPDATE public.one_time_code_challenge SET delivery_status = p_outcome,
    invalidation_reason = CASE WHEN p_outcome = 'failed' AND invalidated_at IS NULL
      AND consumed_at IS NULL THEN 'delivery_failed' ELSE invalidation_reason END,
    invalidated_at = CASE WHEN p_outcome = 'failed' AND invalidated_at IS NULL
      AND consumed_at IS NULL THEN now() ELSE invalidated_at END
  WHERE id = ch.id;
END $$;
--> statement-breakpoint

-- D23, D25, D28, D29: the activation in one transaction. The verification first: for an
-- `in_person` code the retyped address (a mismatch counts on the code), else the one-time code (a
-- wrong one counts on it); either returns its result without writing anything else. Then the code
-- is used, the account, consent and channel are written, `imported`/`unreachable` become
-- `contacted` by the participant (the cutoff checked again by database time), the audit events
-- written, the activating sessions ended and an `active` one started with the new token. Returns
-- `activated`, or `mismatch`, `locked`, `one_time_code_invalid`, `one_time_code_exhausted`.
CREATE FUNCTION complete_activation(
  p_token_hash text, p_new_token_hash text, p_notice_version text, p_consent_version text,
  p_language notice_language, p_channel_id uuid, p_consent_id uuid, p_request_id text,
  p_one_time_code_hash text DEFAULT NULL, p_delivery_address text DEFAULT NULL,
  p_delivery_address_hash text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.participant_session;
  c public.activation_code;
  p public.participation;
  v public.one_time_code_challenge;
  v_result text;
  v_challenge_id uuid;
  v_kind public.contact_channel_kind;
  v_address text;
  v_verified_by public.channel_verification;
  v_assurance public.identity_assurance;
  v_context public.audit_context;
BEGIN
  IF p_new_token_hash IS NULL OR p_new_token_hash !~ '^[0-9a-f]{64}$'
     OR p_notice_version IS DISTINCT FROM 'art14-activation:v1'
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v1'
     OR p_language IS NULL OR p_channel_id IS NULL OR p_consent_id IS NULL
     OR (p_one_time_code_hash IS NULL) = (p_delivery_address IS NULL)
     OR (p_delivery_address IS NULL) <> (p_delivery_address_hash IS NULL)
     OR p_one_time_code_hash !~ '^[0-9a-f]{64}$' OR p_delivery_address_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
  IF NOT FOUND OR s.state <> 'activating' THEN RAISE EXCEPTION 'session_invalid'; END IF;
  p := public.lock_participation(s.participation_id);
  s := public.lock_activating_session(p_token_hash);
  SELECT * INTO c FROM public.activation_code WHERE id = s.activation_code_id;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT status FROM public.project WHERE id = p.project_id) <> 'active'
     OR EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id) THEN
    RAISE EXCEPTION 'code_invalid';
  END IF;
  IF NOT public.participation_before_cutoff(p) THEN RAISE EXCEPTION 'before_cutoff'; END IF;
  IF public.activation_needs_birth_date(c) AND s.birth_date_checked_at IS NULL
     OR (c.channel = 'in_person') <> (p_delivery_address IS NOT NULL)
     OR c.channel = 'in_person' AND s.delivery_address_checked_at IS NULL THEN
    RAISE EXCEPTION 'step_not_allowed';
  END IF;
  v_context := public.participant_context(p.id, p_request_id);

  IF c.channel = 'in_person' THEN
    IF p_delivery_address_hash <> c.delivery_address_hash THEN
      RETURN public.count_activation_failure(c.id, p_request_id);
    END IF;
    v_kind := c.delivery_kind::text::public.contact_channel_kind;
    v_address := p_delivery_address;
    v_verified_by := 'activation_link';
  ELSE
    SELECT * INTO v_result, v_challenge_id FROM public.verify_one_time_code(p.id,
      'channel_verification', p_one_time_code_hash, p_request_id);
    IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
    IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
    SELECT * INTO v FROM public.one_time_code_challenge WHERE id = v_challenge_id;
    v_kind := v.kind;
    v_address := v.address;
    v_verified_by := 'one_time_code';
  END IF;
  -- Raised refusals from here on roll the verification back too: the code stays usable.
  PERFORM public.assert_channel_available(p.id, v_kind, v_address);

  UPDATE public.activation_code SET used_at = now() WHERE id = c.id;
  INSERT INTO public.consent_record (
    id, project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
  VALUES (p_consent_id, p.project_id, p.id, 'portal_contact', p_channel_id, p_consent_version,
    p_language, 'participant');
  BEGIN
    INSERT INTO public.participant_channel (
      id, project_id, participation_id, kind, address, verified_by, consent_id)
    VALUES (p_channel_id, p.project_id, p.id, v_kind, v_address, v_verified_by, p_consent_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'channel_in_use';
  END;
  v_assurance := CASE WHEN s.birth_date_checked_at IS NOT NULL THEN 'birth_date' ELSE 'photo_id' END;
  INSERT INTO public.participant_account (
    participation_id, project_id, activation_code_id, identity_assurance, identity_assured_by,
    identity_assured_at, language)
  VALUES (p.id, p.project_id, c.id, v_assurance,
    CASE WHEN v_assurance = 'photo_id' THEN c.identity_checked_by END,
    CASE WHEN v_assurance = 'photo_id' THEN c.identity_checked_at END, p_language);

  PERFORM public.write_audit_event(p.project_id, p.id, 'participant_activated', v_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('activationCodeId', c.id,
      'identityAssurance', v_assurance, 'noticeVersion', p_notice_version,
      'language', p_language), false);
  PERFORM public.write_audit_event(p.project_id, p.id, 'consent_given', v_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', p_channel_id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  PERFORM public.write_audit_event(p.project_id, p.id, 'contact_channel_added', v_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('channelId', p_channel_id,
      'kind', v_kind, 'verifiedBy', v_verified_by), false);
  -- Q116: a first activation contacts; `contacted` and later statuses stay as they are.
  IF p.status IN ('imported', 'unreachable') THEN
    PERFORM public.apply_status_change(p.id, 'status', p.status::text, 'contacted', v_context,
      p_activation => true);
  END IF;

  UPDATE public.participant_session SET ended_at = now(), end_reason = 'activated'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  INSERT INTO public.participant_session (
    token_hash, project_id, participation_id, state, step_up_method, step_up_at)
  VALUES (p_new_token_hash, p.project_id, p.id, 'active',
    CASE WHEN s.step_up_method IS NOT NULL THEN s.step_up_method
         WHEN v_verified_by = 'one_time_code' THEN 'one_time_code'::public.step_up_method END,
    CASE WHEN s.step_up_method IS NOT NULL THEN s.step_up_at
         WHEN v_verified_by = 'one_time_code' THEN now() END);
  RETURN 'activated';
END $$;
--> statement-breakpoint

-- Logout (and the end of an abandoned activation): ends a live session; an active one's logout is
-- audited as the participant. Returns whether a session ended.
CREATE FUNCTION end_participant_session(p_token_hash text, p_request_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session;
BEGIN
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'logout'
  WHERE token_hash = p_token_hash AND ended_at IS NULL RETURNING * INTO s;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.state = 'active' THEN
    PERFORM public.write_audit_event(s.project_id, s.participation_id, 'participant_logout',
      public.participant_context(s.participation_id, p_request_id), NULL, NULL, NULL, NULL, NULL,
      '{}'::jsonb, false);
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint

-- D21: the activation notice went out (job `portal.activation-notice`); the first record stands,
-- so a second run of the job finds it sent. Returns whether this call recorded it.
CREATE FUNCTION mark_activation_notice_sent(p_channel_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.participant_channel SET notice_sent_at = now()
  WHERE id = p_channel_id AND notice_sent_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- An activated account gets a new code only through recovery (D17, D24 in 3f); otherwise
-- unchanged from 0040.
CREATE OR REPLACE FUNCTION issue_activation_code(
  p_participation_id uuid, p_code_hash text, p_channel activation_channel,
  p_language notice_language, p_notice_version text, p_replace_open_code boolean,
  p_delivery_kind activation_delivery_kind, p_delivery_address_hash text,
  p_identity_checked boolean, p_context audit_context, p_id uuid DEFAULT NULL
) RETURNS activation_code LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.participation;
  pr public.project;
  i public.participant_identity;
  d public.participant_details;
  old public.activation_code;
  made public.activation_code;
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_latest date;
  v_notice_id uuid;
BEGIN
  p := public.lock_participation(p_participation_id);
  PERFORM public.assert_activation_actor(p.project_id, p_context);
  SELECT * INTO pr FROM public.project WHERE id = p.project_id;
  IF pr.status <> 'active' THEN RAISE EXCEPTION 'project_not_active'; END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id) THEN
    RAISE EXCEPTION 'already_activated';
  END IF;
  IF p.status IN ('imported', 'contacted', 'unreachable') THEN
    SELECT latest_entry_date INTO v_latest FROM public.project_entry_wave WHERE id = p.entry_wave_id;
    IF v_latest IS NOT NULL AND v_today > v_latest THEN RAISE EXCEPTION 'before_cutoff'; END IF;
  END IF;
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR p_notice_version <> 'art14-activation:v1' OR p_replace_open_code IS NULL
     OR p_identity_checked IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO i FROM public.participant_identity WHERE participation_id = p_participation_id;
  SELECT * INTO d FROM public.participant_details WHERE participation_id = p_participation_id;
  IF p_channel = 'letter' AND i.birth_date IS NULL THEN RAISE EXCEPTION 'birth_date_required'; END IF;
  IF p_channel = 'letter' AND d.address_street IS NULL THEN RAISE EXCEPTION 'address_required'; END IF;
  IF p_channel = 'in_person' AND NOT p_identity_checked THEN
    RAISE EXCEPTION 'identity_not_checked';
  END IF;
  IF (p_channel = 'in_person') IS DISTINCT FROM
       (p_delivery_kind IS NOT NULL AND p_delivery_address_hash ~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO old FROM public.activation_code
  WHERE participation_id = p_participation_id AND revoked_at IS NULL AND used_at IS NULL
    AND locked_at IS NULL FOR UPDATE;
  IF FOUND AND old.expires_at > now() AND NOT p_replace_open_code THEN
    RAISE EXCEPTION 'open_code_exists';
  END IF;
  IF FOUND THEN
    UPDATE public.activation_code SET revoked_at = now(), revoked_by = (p_context).staff_user_id,
      revoke_reason = 'reissued' WHERE id = old.id;
    PERFORM public.write_audit_event(p.project_id, p.id, 'activation_code_revoked', p_context,
      NULL, NULL, NULL, 'reissued', NULL,
      pg_catalog.jsonb_build_object('activationCodeId', old.id), false);
  END IF;
  BEGIN
    INSERT INTO public.activation_code (
      id, project_id, participation_id, purpose, code_hash, channel, notice_language,
      identity_check, identity_checked_by, identity_checked_at, printed_at, delivery_kind,
      delivery_address_hash, delivery_status, issued_by, expires_at)
    VALUES (v_id, p.project_id, p.id, 'activation', p_code_hash, p_channel, p_language,
       CASE WHEN p_channel = 'in_person' THEN 'photo_id'::public.identity_check
            ELSE 'none'::public.identity_check END,
      CASE WHEN p_channel = 'in_person' THEN (p_context).staff_user_id END,
      CASE WHEN p_channel = 'in_person' THEN now() END,
      CASE WHEN p_channel IN ('letter', 'sheet') THEN now() END,
      p_delivery_kind, p_delivery_address_hash,
       CASE WHEN p_channel = 'in_person' THEN 'pending'::public.activation_delivery_status END,
      (p_context).staff_user_id, now() + interval '30 days')
    RETURNING * INTO made;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'code_hash_collision';
  END;
  PERFORM public.write_audit_event(p.project_id, p.id, 'activation_code_issued', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'activationCodeId', made.id, 'purpose', made.purpose, 'channel', made.channel,
      'identityCheck', made.identity_check, 'deliveryKind', made.delivery_kind,
      'noticeVersion', p_notice_version, 'language', p_language)), false);
  -- A letter printout carries this exact notice (Q124). A sheet is evidence only at the later
  -- ID-checked handover; in-person evidence is written only after a definitive successful send.
  IF p_channel = 'letter' THEN
    INSERT INTO public.privacy_notice_delivery (
      project_id, participation_id, notice_version, language, method, activation_code_id, provided_by)
    VALUES (p.project_id, p.id, p_notice_version, p_language,
      'letter'::public.notice_method,
      made.id, (p_context).staff_user_id) RETURNING id INTO v_notice_id;
    PERFORM public.write_audit_event(p.project_id, p.id, 'privacy_notice_provided', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
        'noticeDeliveryId', v_notice_id, 'activationCodeId', made.id,
        'noticeVersion', p_notice_version, 'language', p_language,
        'method', 'letter'), false);
  END IF;
  RETURN made;
END $$;
--> statement-breakpoint

-- D26: a terminal status revokes open codes and ends the participant's sessions in its own
-- transaction (the status function's).
CREATE OR REPLACE FUNCTION revoke_codes_at_terminal_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c record;
BEGIN
  IF NEW.status IN ('withdrawn', 'ta_completed', 'exited')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR c IN UPDATE public.activation_code SET revoked_at = now(), revoked_by = NULL,
      revoke_reason = 'participation_closed'
      WHERE participation_id = NEW.id AND revoked_at IS NULL AND locked_at IS NULL AND used_at IS NULL
      RETURNING id
    LOOP
      INSERT INTO public.audit_event (project_id, participation_id, event_type, actor_type,
        system_job, reason_code, details)
      VALUES (NEW.project_id, NEW.id, 'activation_code_revoked', 'system',
        'terminal-code-revocation', 'participation_closed',
        pg_catalog.jsonb_build_object('activationCodeId', c.id));
    END LOOP;
    UPDATE public.participant_session SET ended_at = now(), end_reason = 'participation_closed'
    WHERE participation_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- These event types are written only by the functions above (and those of 0040).
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
      'one_time_code_exhausted', 'participant_logout') THEN
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

REVOKE ALL ON FUNCTION apply_status_change, participant_context, portal_system_context,
  participant_session_live, activation_code_open, participation_before_cutoff,
  activation_needs_birth_date, contact_address_valid, assert_channel_available,
  lock_activating_session, count_activation_failure, insert_one_time_code, verify_one_time_code,
  start_activation, check_activation_birth_date, check_activation_delivery_address,
  create_one_time_code, record_one_time_code_delivery, complete_activation,
  end_participant_session, mark_activation_notice_sent FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION start_activation, check_activation_birth_date,
  check_activation_delivery_address, create_one_time_code, record_one_time_code_delivery,
  complete_activation, end_participant_session, mark_activation_notice_sent TO transfer_app;
--> statement-breakpoint
GRANT SELECT ON TABLE participant_account, consent_record, participant_channel,
  one_time_code_challenge, participant_session TO transfer_app;
--> statement-breakpoint
-- D29: the API writes `last_seen_at` (at most once a minute); nothing else of a session.
GRANT UPDATE (last_seen_at) ON TABLE participant_session TO transfer_app;
