-- Hand-written (ADR-0002, reminders; data-protection.md, reminders and consent v2; Q152–Q156):
-- the reminder functions, consent v2 and their grants. Same hardening as 0054: SECURITY DEFINER
-- owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no
-- dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code,
-- never a value. Audit entries carry ids and codes only: never an address, a text or a provider
-- answer. The new enum values of 0055 are compared as text here, as 0054 does, since this runs in
-- the same migration transaction.

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
    'document_deleted', 'document_upload_rejected', 'reminder_queued', 'reminder_delivery'));
--> statement-breakpoint

-- Internal helpers (no grant).

-- Whether a staff user may remind for the participation now (Q153): an active account that is PL
-- of its project, or its consultant while assigned (`document_staff_roles`).
CREATE FUNCTION reminder_requester_allowed(p_participation_id uuid, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.document_staff_roles(p_participation_id, p_staff_user_id)
    && '{project_lead,consultant}'::text[]
$$;
--> statement-breakpoint

-- The system context of the job `reminders.send` (ADR-0011).
CREATE FUNCTION reminder_job_context(p_job_id text)
RETURNS audit_context LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ROW('system', NULL, NULL, 'reminders.send', NULL, NULL, p_job_id)::public.audit_context
$$;
--> statement-breakpoint

-- A reminder's final state with its `reminder_delivery` event (the cancel reason as its reason
-- code). The caller holds the reminder's row lock.
CREATE FUNCTION settle_reminder(
  r participant_reminder, p_status reminder_status, p_cancel_reason reminder_cancel_reason,
  p_job_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.participant_reminder SET status = p_status, cancel_reason = p_cancel_reason,
    outcome_at = now()
  WHERE id = r.id;
  PERFORM public.write_audit_event(r.project_id, r.participation_id, 'reminder_delivery',
    public.reminder_job_context(p_job_id), NULL, NULL, NULL, p_cancel_reason::text, NULL,
    pg_catalog.jsonb_build_object('reminderId', r.id, 'outcome', p_status), false);
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A reminder request (data-protection.md, reminders; Q153–Q155): a PL of the project or the
-- assigned consultant, in normal mode, for 1–500 distinct participations of the active project,
-- under the exclusive project lock. Refused as a whole: `participation_not_found` (another
-- project's id, or for a consultant one not assigned to them), `actor_not_allowed` (any other
-- role, assisted mode), `project_not_active`. The API passes only participations with something
-- open (and closed ones) and skips the rest `nothing_open` itself. Per row, in order:
-- `participation_closed`, `no_channel` (no live channel), `consent_required` (a live channel, none
-- with a live consent v2), `reminded_recently` (one queued within 3 Berlin calendar days, whatever
-- its outcome). Otherwise it picks the channel (the most recently verified email, else mobile;
-- the smaller id on a tie), fixes it, its consent and the account's language, writes the row
-- `queued` and `reminder_queued`. Returns one row per participation: the reminder and its channel
-- kind, or the skip code.
CREATE FUNCTION request_reminders(
  p_context audit_context, p_project_id uuid, p_participation_ids uuid[], p_kind reminder_kind,
  p_message_version text, p_batch_id uuid
) RETURNS TABLE (participation_id uuid, reminder_id uuid, channel_kind contact_channel_kind,
  skip text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_staff uuid := (p_context).staff_user_id;
  v_roles text[];
  v_today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_id uuid;
  p public.participation;
  ch record;
  v_reminder uuid;
BEGIN
  IF p_project_id IS NULL OR p_kind IS NULL OR p_batch_id IS NULL
     OR p_message_version IS DISTINCT FROM 'portal-reminder:v1'
     OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM unnest(p_participation_ids) x)
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM public.lock_project_setup(p_project_id);
  IF EXISTS (SELECT FROM unnest(p_participation_ids) x
             WHERE NOT EXISTS (SELECT FROM public.participation q
                               WHERE q.id = x AND q.project_id = p_project_id)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  v_roles := ARRAY(
    SELECT DISTINCT m.role::text FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = v_staff);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF NOT 'project_lead' = ANY (v_roles) AND EXISTS (
    SELECT FROM unnest(p_participation_ids) x
    WHERE NOT EXISTS (SELECT FROM public.participant_assignment a
                      WHERE a.participation_id = x AND a.staff_user_id = v_staff
                        AND a.ended_at IS NULL)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (SELECT status FROM public.project WHERE id = p_project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;

  FOREACH v_id IN ARRAY p_participation_ids LOOP
    p := public.lock_participation(v_id);
    participation_id := v_id;
    reminder_id := NULL;
    channel_kind := NULL;
    skip := NULL;
    IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
      skip := 'participation_closed';
    ELSIF NOT EXISTS (SELECT FROM public.participant_channel c
                      WHERE c.participation_id = v_id AND c.removed_at IS NULL
                        AND c.suspended_at IS NULL) THEN
      skip := 'no_channel';
    ELSE
      SELECT c.id, c.kind, c.consent_id INTO ch
      FROM public.participant_channel c
      JOIN public.consent_record k ON k.id = c.consent_id
      WHERE c.participation_id = v_id AND c.removed_at IS NULL AND c.suspended_at IS NULL
        AND k.purpose = 'portal_contact' AND k.text_version = 'portal-contact-consent:v2'
        AND k.ended_at IS NULL
      ORDER BY c.kind = 'email' DESC, c.verified_at DESC, c.id
      LIMIT 1;
      IF NOT FOUND THEN
        skip := 'consent_required';
      ELSIF EXISTS (SELECT FROM public.participant_reminder r
                    WHERE r.participation_id = v_id AND r.requested_on > v_today - 3) THEN
        skip := 'reminded_recently';
      ELSE
        v_reminder := gen_random_uuid();
        INSERT INTO public.participant_reminder (id, project_id, participation_id, batch_id, kind,
          message_version, language, channel_id, channel_kind, consent_id, requested_by,
          requested_on)
        SELECT v_reminder, p.project_id, v_id, p_batch_id, p_kind, p_message_version, a.language,
          ch.id, ch.kind, ch.consent_id, v_staff, v_today
        FROM public.participant_account a WHERE a.participation_id = v_id;
        PERFORM public.write_audit_event(p.project_id, v_id, 'reminder_queued', p_context, NULL,
          NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('reminderId', v_reminder,
            'batchId', p_batch_id, 'kind', p_kind, 'channelKind', ch.kind), false);
        reminder_id := v_reminder;
        channel_kind := ch.kind;
      END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint

-- The dispatch claim of the job `reminders.send` (data-protection.md, reminders; Q154): the job
-- locked the participation and evaluated its actions (`p_has_actions`) in this transaction
-- first. With the reminder locked and its queued channel and consent rows `FOR SHARE`, it rechecks
-- exactly them: the participation open (`participation_closed`), the channel live and still on
-- that consent (`channel_unavailable`), the consent live, of the portal contact purpose and
-- version v2 (`consent_ended`), the requester still PL or the assigned consultant
-- (`requester_no_longer_authorized`), something open (`nothing_open`). A queued reminder that
-- fails a check is cancelled with that reason and the reason returned; one already `dispatching`
-- (a retry after an unknown outcome) ends `delivery_unknown` (`settled`). Otherwise it becomes
-- `dispatching` (returned). A reminder already final returns `settled`. A change committed before
-- this claim is seen; one committed after it may still see the message sent.
CREATE FUNCTION claim_reminder_dispatch(p_reminder_id uuid, p_has_actions boolean, p_job_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participant_reminder;
  p public.participation;
  ch public.participant_channel;
  k public.consent_record;
  v_reason public.reminder_cancel_reason;
BEGIN
  IF p_reminder_id IS NULL OR p_has_actions IS NULL OR p_job_id IS NULL
     OR p_job_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  p := public.lock_participation(r.participation_id);
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF r.status NOT IN ('queued', 'dispatching') THEN
    RETURN 'settled';
  END IF;
  SELECT * INTO ch FROM public.participant_channel WHERE id = r.channel_id FOR SHARE;
  SELECT * INTO k FROM public.consent_record WHERE id = r.consent_id FOR SHARE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    v_reason := 'participation_closed';
  ELSIF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL THEN
    v_reason := 'channel_unavailable';
  ELSIF ch.consent_id <> r.consent_id OR k.ended_at IS NOT NULL OR k.purpose <> 'portal_contact'
        OR k.text_version <> 'portal-contact-consent:v2' THEN
    v_reason := 'consent_ended';
  ELSIF NOT public.reminder_requester_allowed(r.participation_id, r.requested_by) THEN
    v_reason := 'requester_no_longer_authorized';
  ELSIF NOT p_has_actions THEN
    v_reason := 'nothing_open';
  END IF;
  IF v_reason IS NULL THEN
    UPDATE public.participant_reminder SET status = 'dispatching', claimed_at = now()
    WHERE id = r.id;
    RETURN 'dispatching';
  END IF;
  IF r.status = 'dispatching' THEN
    PERFORM public.settle_reminder(r, 'delivery_unknown', NULL, p_job_id);
    RETURN 'settled';
  END IF;
  PERFORM public.settle_reminder(r, 'cancelled', v_reason, p_job_id);
  RETURN v_reason::text;
END $$;
--> statement-breakpoint

-- A reminder's outcome, by the job (ADR-0011): `sent`, `failed` (definitive) or
-- `delivery_unknown` (the last attempt's error) of a `dispatching` one; `cancelled` with
-- `delivery_unavailable` (no sender) of a `queued` one. Once per reminder: the same outcome again
-- returns false and writes nothing; another raises `reminder_settled`; a transition from another
-- state raises `reminder_not_dispatching`. Audited `reminder_delivery` as the system.
CREATE FUNCTION record_reminder_outcome(
  p_reminder_id uuid, p_outcome reminder_status, p_cancel_reason reminder_cancel_reason,
  p_job_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participant_reminder;
BEGIN
  IF p_reminder_id IS NULL OR p_outcome IS NULL OR p_job_id IS NULL
     OR p_job_id !~ '^[A-Za-z0-9_.:-]{1,64}$'
     OR p_outcome::text NOT IN ('sent', 'failed', 'delivery_unknown', 'cancelled')
     OR (p_outcome = 'cancelled') <> (p_cancel_reason IS NOT NULL)
     OR p_outcome = 'cancelled' AND p_cancel_reason <> 'delivery_unavailable' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  IF r.status NOT IN ('queued', 'dispatching') THEN
    IF r.status = p_outcome AND r.cancel_reason IS NOT DISTINCT FROM p_cancel_reason THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'reminder_settled';
  END IF;
  IF (p_outcome = 'cancelled') <> (r.status = 'queued') THEN
    RAISE EXCEPTION 'reminder_not_dispatching';
  END IF;
  PERFORM public.settle_reminder(r, p_outcome, p_cancel_reason, p_job_id);
  RETURN true;
END $$;
--> statement-breakpoint

-- The voluntary upgrade of a channel's consent to v2 (data-protection.md, consent v2; Q154): the
-- participant through their live active session only; no staff or assisted route exists. Locks
-- the participation (with the session), then the channel, then its consent. A channel that isn't
-- the session's own live one is `channel_not_found`; a version other than v2 `invalid_argument`.
-- A channel already on v2 returns `already_current` and writes nothing. Otherwise the earlier
-- consent ends `superseded` (never `revoked`), the participant's v2 consent is inserted and the
-- channel points to it, audited `consent_ended` and `consent_given`; the address isn't verified
-- again. Returns `upgraded`.
CREATE FUNCTION upgrade_channel_consent(
  p_token_hash text, p_channel_id uuid, p_consent_id uuid, p_consent_version text,
  p_language notice_language, p_request_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.participant_session;
  ch public.participant_channel;
  k public.consent_record;
  v_context public.audit_context;
BEGIN
  IF p_channel_id IS NULL OR p_consent_id IS NULL OR p_language IS NULL
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v2' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  s := public.lock_active_session(p_token_hash);
  SELECT * INTO ch FROM public.participant_channel
  WHERE id = p_channel_id AND participation_id = s.participation_id AND removed_at IS NULL
    AND suspended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_not_found';
  END IF;
  SELECT * INTO k FROM public.consent_record WHERE id = ch.consent_id FOR UPDATE;
  UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  IF k.text_version = p_consent_version AND k.ended_at IS NULL THEN
    RETURN 'already_current';
  END IF;
  v_context := public.participant_context(s.participation_id, p_request_id);
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'superseded'
  WHERE id = k.id AND ended_at IS NULL;
  INSERT INTO public.consent_record (
    id, project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
  VALUES (p_consent_id, s.project_id, s.participation_id, 'portal_contact', ch.id,
    p_consent_version, p_language, 'participant');
  UPDATE public.participant_channel SET consent_id = p_consent_id WHERE id = ch.id;
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_ended', v_context,
    NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object('consentId', k.id,
      'channelId', ch.id, 'purpose', 'portal_contact'), false);
  PERFORM public.write_audit_event(s.project_id, s.participation_id, 'consent_given', v_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('consentId', p_consent_id,
      'channelId', ch.id, 'purpose', 'portal_contact', 'textVersion', p_consent_version,
      'language', p_language), false);
  RETURN 'upgraded';
END $$;
--> statement-breakpoint

-- Replaced (data-protection.md, consent v2): activation, recovery and a new channel record
-- `portal-contact-consent:v2` only and refuse v1 (`invalid_argument`); otherwise unchanged from 0044.
-- No migration converts an existing v1 consent.
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
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v2'
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

CREATE OR REPLACE FUNCTION add_participant_channel(
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
     OR p_consent_version IS DISTINCT FROM 'portal-contact-consent:v2' THEN
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
END $$;--> statement-breakpoint

-- Replaced: the reminder events are written only by their functions too.
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
      'reminder_queued', 'reminder_delivery') THEN
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

-- Grants: transfer_app selects the reminders and writes none (the functions do).
GRANT SELECT ON TABLE participant_reminder TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reminder_requester_allowed, reminder_job_context, settle_reminder,
  request_reminders, claim_reminder_dispatch, record_reminder_outcome, upgrade_channel_consent
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION request_reminders, claim_reminder_dispatch, record_reminder_outcome,
  upgrade_channel_consent TO transfer_app;
