-- Hand-written (Slice 3 plan, PR 3f; D24, D27, D28): portal login, channel management and
-- lost-access recovery, with 0042's conventions: SECURITY DEFINER with a fixed search_path,
-- executable only by transfer_app, database time, the lock order participation → code → session,
-- counted failures returned (never raised) so the count commits, the audit in the same
-- transaction, and no code, address or hash in an audit row. The limits are portalLimits
-- (packages/domain/src/portal/limits.ts); packages/db/src/portal-limits.int.test.ts holds them.

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
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended'));
--> statement-breakpoint

-- Internal helpers (no grant).

-- D14, D15, D24: an activation or recovery code that can still be used. A sheet only after its
-- handover; a failed in-person delivery is revoked anyway, a pending or unknown one stays valid.
CREATE OR REPLACE FUNCTION activation_code_open(c activation_code)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.revoked_at IS NULL AND c.locked_at IS NULL AND c.used_at IS NULL
    AND c.expires_at > now()
    AND (c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL)
    AND (c.channel <> 'in_person' OR c.delivery_status IN ('pending', 'sent', 'unknown'))
$$;
--> statement-breakpoint

-- D28: a channel is a private address that isn't the imported work email and belongs to no other
-- active channel; a collision is the generic `channel_in_use`, never naming the other account. A
-- recovery (D24) may register an address of the participation's own old channels again: they are
-- removed in the same transaction before the new one is written.
DROP FUNCTION assert_channel_available(uuid, contact_channel_kind, text);
--> statement-breakpoint
CREATE FUNCTION assert_channel_available(
  p_participation_id uuid, p_kind contact_channel_kind, p_address text,
  p_replacing_own boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.contact_address_valid(p_kind, p_address) OR p_kind = 'email' AND EXISTS (
    SELECT FROM public.participant_details d
    WHERE d.participation_id = p_participation_id AND lower(d.work_email) = p_address) THEN
    RAISE EXCEPTION 'channel_invalid';
  END IF;
  IF EXISTS (SELECT FROM public.participant_channel ch
             WHERE ch.kind = p_kind AND ch.address = p_address AND ch.removed_at IS NULL
               AND NOT (p_replacing_own AND ch.participation_id = p_participation_id)) THEN
    RAISE EXCEPTION 'channel_in_use';
  END IF;
END $$;
--> statement-breakpoint

-- D27: checks a one-time code against the participation's live code of `p_purpose` (for a login,
-- only one sent to `p_kind`/`p_address`). A match consumes it (`ok`); a wrong entry counts
-- (`mismatch`), the fifth ends it (`exhausted`, recorded by the system); no live code is `none`.
DROP FUNCTION verify_one_time_code(uuid, one_time_code_purpose, text, text);
--> statement-breakpoint
CREATE FUNCTION verify_one_time_code(
  p_participation_id uuid, p_purpose one_time_code_purpose, p_code_hash text, p_request_id text,
  p_kind contact_channel_kind DEFAULT NULL, p_address text DEFAULT NULL,
  OUT result text, OUT challenge_id uuid
) LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE challenge public.one_time_code_challenge;
BEGIN
  SELECT * INTO challenge FROM public.one_time_code_challenge
  WHERE participation_id = p_participation_id AND purpose = p_purpose AND consumed_at IS NULL
    AND invalidated_at IS NULL AND expires_at > now() AND failed_attempts < 5
    AND (p_kind IS NULL OR kind = p_kind AND address = p_address)
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN result := 'none'; RETURN; END IF;
  challenge_id := challenge.id;
  IF challenge.code_hash = p_code_hash THEN
    UPDATE public.one_time_code_challenge SET consumed_at = now() WHERE id = challenge.id;
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

-- Whether a participation may use the portal at all: an activated account in an active project,
-- the participation not terminal (Q121).
CREATE FUNCTION participant_account_usable(p participation)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.status NOT IN ('withdrawn', 'ta_completed', 'exited')
    AND (SELECT status FROM public.project WHERE id = p.project_id) = 'active'
    AND EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id)
$$;
--> statement-breakpoint

-- The live active session of `p_token_hash`, its participation locked first (the lock order of
-- every portal function), then the session.
CREATE FUNCTION lock_active_session(p_token_hash text)
RETURNS participant_session LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; p public.participation;
BEGIN
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash;
  IF NOT FOUND OR s.state <> 'active' THEN RAISE EXCEPTION 'session_invalid'; END IF;
  p := public.lock_participation(s.participation_id);
  SELECT * INTO s FROM public.participant_session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT public.participant_session_live(s) OR NOT public.participant_account_usable(p) THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  RETURN s;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- D22, D23, D24: a submitted code starts an `activating` session. An activation code needs an
-- account not yet activated, a recovery code an activated one; any other unknown, expired,
-- revoked, used, locked or not handed-over code returns NULL (the one generic answer) and counts
-- nothing. A first activation past the cutoff refuses `before_cutoff` (D25); a recovery has none
-- (Q121). A new session of the same code supersedes the earlier one.
CREATE OR REPLACE FUNCTION start_activation(p_code_hash text, p_token_hash text, p_request_id text)
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
     OR EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id)
        <> (c.purpose = 'recovery') THEN
    RETURN NULL;
  END IF;
  IF c.purpose = 'activation' AND NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'before_cutoff';
  END IF;
  UPDATE public.participant_session SET ended_at = now(), end_reason = 'superseded'
  WHERE activation_code_id = c.id AND ended_at IS NULL;
  INSERT INTO public.participant_session (token_hash, project_id, participation_id, state, activation_code_id)
  VALUES (p_token_hash, p.project_id, p.id, 'activating', c.id);
  RETURN pg_catalog.jsonb_build_object('purpose', c.purpose, 'channel', c.channel,
    'deliveryKind', c.delivery_kind, 'language', c.notice_language,
    'needsBirthDate', public.activation_needs_birth_date(c));
END $$;
--> statement-breakpoint

-- D23, D27: a one-time code for the private email or mobile the participant chose, committed
-- `pending` before the send (D20). Refuses an in-person code, a missing birth-date step, an
-- invalid or taken address (in a recovery, the participation's own old addresses are free again)
-- and the sixth code in an hour per address. Returns the expiry.
CREATE OR REPLACE FUNCTION create_one_time_code(
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
  PERFORM public.assert_channel_available(s.participation_id, p_kind, p_address,
    c.purpose = 'recovery');
  made := public.insert_one_time_code(s.project_id, s.participation_id, 'channel_verification',
    p_kind, p_address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN made.expires_at;
END $$;
--> statement-breakpoint

-- D23, D24, D25, D28, D29: the activation or recovery in one transaction. The verification first:
-- for an `in_person` code the retyped address (a mismatch counts on the code), else the one-time
-- code (a wrong one counts on it); either returns its result without writing anything else. Then
-- the code is used and the consent and channel written. A first activation writes the account,
-- `imported`/`unreachable` become `contacted` by the participant (the cutoff checked again by
-- database time). A recovery replaces the old channels (removed, their consents ended, both with
-- `lost_access_replaced`, never a withdrawal; Q130), changes no status and is the participant's
-- login. The activating sessions end and an `active` one starts with the new token. Returns
-- `activated` or `recovered`, or `mismatch`, `locked`, `one_time_code_invalid`,
-- `one_time_code_exhausted`.
CREATE OR REPLACE FUNCTION complete_activation(
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
  old record;
  v_recovery boolean;
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
  v_recovery := c.purpose = 'recovery';
  IF p.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT status FROM public.project WHERE id = p.project_id) <> 'active'
     OR EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id)
        <> v_recovery THEN
    RAISE EXCEPTION 'code_invalid';
  END IF;
  IF NOT v_recovery AND NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'before_cutoff';
  END IF;
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
  PERFORM public.assert_channel_available(p.id, v_kind, v_address, v_recovery);

  UPDATE public.activation_code SET used_at = now() WHERE id = c.id;
  IF v_recovery THEN
    FOR old IN UPDATE public.participant_channel SET removed_at = now(),
        removed_reason = 'lost_access_replaced'
      WHERE participation_id = p.id AND removed_at IS NULL
      RETURNING id, kind, consent_id
    LOOP
      UPDATE public.consent_record SET ended_at = now(), end_reason = 'lost_access_replaced'
      WHERE id = old.consent_id AND ended_at IS NULL;
      PERFORM public.write_audit_event(p.project_id, p.id, 'consent_ended', v_context, NULL, NULL,
        NULL, 'lost_access_replaced', NULL, pg_catalog.jsonb_build_object('consentId',
          old.consent_id, 'channelId', old.id, 'purpose', 'portal_contact'), false);
      PERFORM public.write_audit_event(p.project_id, p.id, 'contact_channel_removed', v_context,
        NULL, NULL, NULL, 'lost_access_replaced', NULL,
        pg_catalog.jsonb_build_object('channelId', old.id, 'kind', old.kind), false);
    END LOOP;
  END IF;
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

  IF NOT v_recovery THEN
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
  END IF;
  PERFORM public.write_audit_event(p.project_id, p.id, 'consent_given', v_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', p_channel_id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  PERFORM public.write_audit_event(p.project_id, p.id, 'contact_channel_added', v_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('channelId', p_channel_id,
      'kind', v_kind, 'verifiedBy', v_verified_by), false);
  IF v_recovery THEN
    PERFORM public.write_audit_event(p.project_id, p.id, 'participant_login', v_context, NULL,
      NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('method', 'recovery_code',
        'activationCodeId', c.id), false);
  -- Q116: a first activation contacts; `contacted` and later statuses stay as they are.
  ELSIF p.status IN ('imported', 'unreachable') THEN
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
  RETURN CASE WHEN v_recovery THEN 'recovered' ELSE 'activated' END;
END $$;
--> statement-breakpoint

-- D27: a login code to the address of a live channel, committed `pending` before the send (D20).
-- An address of no channel, a suspended channel (D24) or an account that can't be used gets no
-- code and the same answer (the API says `202` either way): returns the challenge's id or NULL.
-- The sixth code in an hour per address raises `rate_limited` (login and verification together).
CREATE FUNCTION request_login_code(
  p_kind contact_channel_kind, p_address text, p_code_hash text, p_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ch public.participant_channel; p public.participation; made public.one_time_code_challenge;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL OR p_id IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE kind = p_kind AND address = p_address AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  p := public.lock_participation(ch.participation_id);
  SELECT * INTO ch FROM public.participant_channel WHERE id = ch.id;
  IF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL
     OR NOT public.participant_account_usable(p) THEN
    RETURN NULL;
  END IF;
  made := public.insert_one_time_code(p.project_id, p.id, 'login', p_kind, p_address,
    p_code_hash, p_id);
  RETURN made.id;
END $$;
--> statement-breakpoint

-- D20: the outcome of a login code's send, recorded after it (there is no session yet). A
-- definitive failure invalidates the code unless it was consumed or superseded during the send;
-- an unknown outcome stays valid.
CREATE FUNCTION record_login_code_delivery(p_challenge_id uuid, p_outcome activation_delivery_status)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ch public.one_time_code_challenge;
BEGIN
  SELECT * INTO ch FROM public.one_time_code_challenge WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR ch.purpose <> 'login' THEN RAISE EXCEPTION 'challenge_not_found'; END IF;
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

-- D27, D29: a login with the code sent to a live channel's address starts an `active` session with
-- its step-up, audited as the participant. An address of no live channel, an unusable account, no
-- live code or a wrong one is `one_time_code_invalid` (a wrong one counts); the fifth wrong entry
-- is `one_time_code_exhausted`. Returns `ok` or one of those.
CREATE FUNCTION start_participant_session(
  p_kind contact_channel_kind, p_address text, p_code_hash text, p_token_hash text,
  p_request_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ch public.participant_channel; p public.participation; v_result text; v_challenge uuid;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO ch FROM public.participant_channel
  WHERE kind = p_kind AND address = p_address AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN 'one_time_code_invalid'; END IF;
  p := public.lock_participation(ch.participation_id);
  SELECT * INTO ch FROM public.participant_channel WHERE id = ch.id;
  IF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL
     OR NOT public.participant_account_usable(p) THEN
    RETURN 'one_time_code_invalid';
  END IF;
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(p.id, 'login',
    p_code_hash, p_request_id, p_kind, p_address);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  INSERT INTO public.participant_session (
    token_hash, project_id, participation_id, state, step_up_method, step_up_at)
  VALUES (p_token_hash, p.project_id, p.id, 'active', 'one_time_code', now());
  PERFORM public.write_audit_event(p.project_id, p.id, 'participant_login',
    public.participant_context(p.id, p_request_id), NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('method', 'one_time_code', 'channelId', ch.id), false);
  RETURN 'ok';
END $$;
--> statement-breakpoint

-- D27, D28: a verification code to a new private address of a logged-in participant, committed
-- `pending` before the send (D20); `record_one_time_code_delivery` records the outcome. Refuses
-- an invalid or taken address (the participant's own included) and the sixth code in an hour per
-- address. Returns the expiry.
CREATE FUNCTION request_channel_code(
  p_token_hash text, p_kind contact_channel_kind, p_address text, p_code_hash text, p_id uuid
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; made public.one_time_code_challenge;
BEGIN
  IF p_kind IS NULL OR p_address IS NULL OR p_id IS NULL
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  PERFORM public.assert_channel_available(s.participation_id, p_kind, p_address);
  made := public.insert_one_time_code(s.project_id, s.participation_id, 'channel_verification',
    p_kind, p_address, p_code_hash, p_id);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN made.expires_at;
END $$;
--> statement-breakpoint

-- D28: the verified new channel with its own consent record (text version and language), audited
-- as the participant. A wrong code counts on it (`one_time_code_invalid`, the fifth
-- `one_time_code_exhausted`); a taken address raises the generic `channel_in_use` and rolls the
-- verification back. Returns `added` or one of those.
CREATE FUNCTION add_participant_channel(
  p_token_hash text, p_code_hash text, p_channel_id uuid, p_consent_id uuid,
  p_consent_version text, p_language notice_language, p_request_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.participant_session;
  v public.one_time_code_challenge;
  v_result text;
  v_challenge uuid;
  v_context public.audit_context;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_channel_id IS NULL
     OR p_consent_id IS NULL OR p_language IS NULL
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v1' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO v_result, v_challenge FROM public.verify_one_time_code(s.participation_id,
    'channel_verification', p_code_hash, p_request_id);
  IF v_result IN ('none', 'mismatch') THEN RETURN 'one_time_code_invalid'; END IF;
  IF v_result = 'exhausted' THEN RETURN 'one_time_code_exhausted'; END IF;
  SELECT * INTO v FROM public.one_time_code_challenge WHERE id = v_challenge;
  PERFORM public.assert_channel_available(s.participation_id, v.kind, v.address);
  v_context := public.participant_context(s.participation_id, p_request_id);
  INSERT INTO public.consent_record (
    id, project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
  VALUES (p_consent_id, s.project_id, s.participation_id, 'portal_contact', p_channel_id,
    p_consent_version, p_language, 'participant');
  BEGIN
    INSERT INTO public.participant_channel (
      id, project_id, participation_id, kind, address, verified_by, consent_id)
    VALUES (p_channel_id, s.project_id, s.participation_id, v.kind, v.address, 'one_time_code',
      p_consent_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'channel_in_use';
  END;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_given', v_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', p_channel_id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'contact_channel_added',
    v_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('channelId',
      p_channel_id, 'kind', v.kind, 'verifiedBy', 'one_time_code'), false);
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN 'added';
END $$;
--> statement-breakpoint

-- D28: the participant removes one of their channels; its consent ends `revoked`, both audited as
-- the participant. Removing the last one ends all the participant's sessions (`no_channel`): the
-- account has no way to log in until staff issue a recovery. Returns whether the sessions ended.
CREATE FUNCTION remove_participant_channel(
  p_token_hash text, p_channel_id uuid, p_request_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.participant_session; ch public.participant_channel; v_context public.audit_context;
BEGIN
  IF p_channel_id IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_not_found'; END IF;
  v_context := public.participant_context(s.participation_id, p_request_id);
  UPDATE public.participant_channel SET removed_at = now(), removed_reason = 'consent_revoked'
  WHERE id = ch.id;
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'revoked'
  WHERE id = ch.consent_id AND ended_at IS NULL;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_ended', v_context,
    NULL, NULL, NULL, 'revoked', NULL, pg_catalog.jsonb_build_object('consentId', ch.consent_id,
      'channelId', ch.id, 'purpose', 'portal_contact'), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'contact_channel_removed',
    v_context, NULL, NULL, NULL, 'consent_revoked', NULL,
    pg_catalog.jsonb_build_object('channelId', ch.id, 'kind', ch.kind), false);
  IF NOT EXISTS (SELECT FROM public.participant_channel
                 WHERE participation_id = s.participation_id AND removed_at IS NULL) THEN
    UPDATE public.participant_session SET ended_at = now(), end_reason = 'no_channel'
    WHERE participation_id = s.participation_id AND ended_at IS NULL;
    RETURN true;
  END IF;
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  RETURN false;
END $$;
--> statement-breakpoint

-- D17, D24 (Q130): `p_purpose` `recovery` issues a code for an activated account only (else
-- `not_activated`), without the first activation's cutoff (Q121). Issuing it ends all the
-- participant's sessions and suspends every live channel for login and notifications at once
-- (`contact_channels_suspended`); expiry or revocation of the code leaves them suspended. An
-- activation code for an activated account stays `already_activated`. Otherwise unchanged.
DROP FUNCTION issue_activation_code(uuid, text, activation_channel, notice_language, text, boolean,
  activation_delivery_kind, text, boolean, audit_context, uuid);
--> statement-breakpoint
CREATE FUNCTION issue_activation_code(
  p_participation_id uuid, p_code_hash text, p_channel activation_channel,
  p_language notice_language, p_notice_version text, p_replace_open_code boolean,
  p_delivery_kind activation_delivery_kind, p_delivery_address_hash text,
  p_identity_checked boolean, p_context audit_context, p_id uuid DEFAULT NULL,
  p_purpose activation_purpose DEFAULT 'activation'
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
  v_recovery boolean := p_purpose = 'recovery';
  v_activated boolean;
  v_suspended uuid[];
BEGIN
  p := public.lock_participation(p_participation_id);
  PERFORM public.assert_activation_actor(p.project_id, p_context);
  SELECT * INTO pr FROM public.project WHERE id = p.project_id;
  IF pr.status <> 'active' THEN RAISE EXCEPTION 'project_not_active'; END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF p_purpose IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  v_activated := EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id);
  IF v_activated AND NOT v_recovery THEN RAISE EXCEPTION 'already_activated'; END IF;
  IF NOT v_activated AND v_recovery THEN RAISE EXCEPTION 'not_activated'; END IF;
  IF NOT v_recovery AND p.status IN ('imported', 'contacted', 'unreachable') THEN
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
    VALUES (v_id, p.project_id, p.id, p_purpose, p_code_hash, p_channel, p_language,
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
  -- Q130: a lost phone stops working before the recovery completes.
  IF v_recovery THEN
    UPDATE public.participant_session SET ended_at = now(), end_reason = 'lost_access'
    WHERE participation_id = p.id AND ended_at IS NULL;
    WITH suspended AS (
      UPDATE public.participant_channel SET suspended_at = now(), suspension_reason = 'lost_access'
      WHERE participation_id = p.id AND removed_at IS NULL AND suspended_at IS NULL
      RETURNING id)
    SELECT coalesce(pg_catalog.array_agg(id ORDER BY id), '{}') INTO v_suspended FROM suspended;
    PERFORM public.write_audit_event(p.project_id, p.id, 'contact_channels_suspended', p_context,
      NULL, NULL, NULL, 'lost_access', NULL, pg_catalog.jsonb_build_object(
        'activationCodeId', made.id, 'channelIds', pg_catalog.to_jsonb(v_suspended)), false);
  END IF;
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

-- These event types are written only by their functions.
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
      'contact_channel_removed', 'consent_ended', 'contact_channels_suspended') THEN
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

REVOKE ALL ON FUNCTION assert_channel_available, verify_one_time_code, participant_account_usable,
  lock_active_session, issue_activation_code, request_login_code, record_login_code_delivery,
  start_participant_session, request_channel_code, add_participant_channel,
  remove_participant_channel FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION issue_activation_code, request_login_code, record_login_code_delivery,
  start_participant_session, request_channel_code, add_participant_channel,
  remove_participant_channel TO transfer_app;
