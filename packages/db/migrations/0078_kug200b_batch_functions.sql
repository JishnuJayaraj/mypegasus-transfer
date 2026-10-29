-- Hand-written (ADR-0002, Kug 200b batches; process-and-lifecycle.md, Kug 200b batches;
-- data-protection.md, exports; Q91, Q187, Q203): the batches of a placement Agentur's accepted
-- Kug 200b scans, built, discarded and submitted by the PL under the project's exclusive lock, the
-- members' submissions and, on the route `kug_200b`, their ASU registrations; the Agentur's
-- confirmation; a batch's export link (the operational index) and its re-authorized content; the
-- history's projection rows and the grants. Same hardening as 0076: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value; a stale batch's rows go in the refusal's DETAIL as ids and codes. The event types and the
-- export kind 0077 added are compared as text here, since this runs after it in the same migration
-- run.
--
-- What the API resolves (regional-variation.md, the accepted alternative): the Agentur's batch
-- channel, the artifact and the form versions it rejects as outdated come from the configuration
-- layers, which only the API reads. It reads them after taking the same exclusive project lock
-- every configuration write takes (`lock_project_setup`), and passes them in; the functions compare
-- them with the batch under that lock (`settings_changed`).
--
-- Lock order (ADR-0002, Kug 200b batches; D31): the project's advisory lock exclusive, taken
-- first, then the participation rows in UUID order, their documents in id order (`FOR SHARE`),
-- the batch row, the submissions, the ASU registrations. Every participation function takes the
-- shared lock, so none interleaves with a batch's check and write. The PL acts as themselves in
-- normal mode; nobody else sees a batch.

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
    'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
    'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
    'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set',
    'kug200b_offer_declined', 'declaration_withdrawal_recorded',
    'declaration_withdrawal_ba_notified', 'agentur_submission_recorded',
    'asu_confirmation_recorded'));
--> statement-breakpoint
-- A batch's events are project-level: never a participation's.
ALTER TABLE audit_event ADD CONSTRAINT audit_event_batch_of_project CHECK (
  participation_id IS NULL OR event_type::text NOT IN ('kug200b_batch_created',
    'kug200b_batch_submitted', 'kug200b_batch_discarded'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): the batch's events in no
-- history; a member's submission in the `profiling` stream, the Agentur's confirmation in `case`.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('kug200b_batch_created', NULL, NULL, false, false, '{}'),
  ('kug200b_batch_submitted', NULL, NULL, false, false, '{}'),
  ('kug200b_batch_discarded', NULL, NULL, false, false, '{}'),
  ('agentur_submission_recorded', NULL, 'profiling', false, false,
    '{formCode,formVersion,channel,submittedOn,batchId}'),
  ('asu_confirmation_recorded', NULL, 'case', false, false, '{confirmedOn}');
--> statement-breakpoint

-- The field catalog's new key (the history's field categories): the submissions to an Agentur.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('agenturSubmissions', 'case_internal');
--> statement-breakpoint

-- Internal helpers (no grant).

-- Whether a staff user is an active PL of the project: the only one who sees its batches (Q49).
CREATE FUNCTION kug200b_batch_lead(p_project_id uuid, p_staff_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = p_staff_user_id
      AND m.role = 'project_lead')
$$;
--> statement-breakpoint

-- The project of a batch operation (ADR-0010, visibility before permission before state): the
-- staff user's context, the project's exclusive advisory lock (taken first; acquiring it tells
-- nothing), then visibility: a project the user isn't a member of, or a batch of it they don't
-- lead, is `project_not_found` / `batch_not_found` whatever its state; then permission: a member
-- who isn't its PL, or the PL in assisted mode, `actor_not_allowed`; then a `ta_tg` project
-- (`asu_not_applicable`, Q89).
CREATE FUNCTION lock_kug200b_batch_project(
  p_context audit_context, p_project_id uuid, p_hidden text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF p_hidden = 'batch_not_found'
     AND NOT public.kug200b_batch_lead(p_project_id, (p_context).staff_user_id)
     OR NOT EXISTS (
       SELECT FROM public.project_membership m
       JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
       WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id) THEN
    RAISE EXCEPTION '%', p_hidden;
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT public.kug200b_batch_lead(p_project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
END $$;
--> statement-breakpoint

-- A scan's problem for a batch (the domain's `batchEligibility` and `batchRecheck`, in the same
-- order): the scan live, accepted, neither quarantined nor invalidated, of the participation, with
-- its version (`scan_unusable`); the participation open (`participation_closed`) and placed with
-- the Agentur (`placement_agentur_changed`); for a new batch (`p_member` null) in no open batch
-- (`in_open_batch`), never submitted (`already_submitted`) and on an explicitly chosen route
-- (`asu_route_unset`, Q203: the route decides whether the submission is the registration), for a
-- member its route unchanged (`asu_route_changed`); on `kug_200b` no registration yet
-- (`asu_registered`); its version not one the Agentur rejects as outdated
-- (`form_version_outdated`). Null when none.
CREATE FUNCTION kug200b_member_problem(
  p_participation participation, p_document document, p_agentur_key text,
  p_outdated_versions text[], p_member kug200b_batch_member
) RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_channel public.asu_channel;
BEGIN
  IF p_document.id IS NULL OR p_document.type::text <> 'kug200b_signed_scan'
     OR p_document.participation_id IS DISTINCT FROM p_participation.id
     OR p_document.deleted_at IS NOT NULL OR p_document.review_state <> 'accepted'
     OR p_document.quarantined_at IS NOT NULL OR p_document.invalidated_by_correction IS NOT NULL
     OR p_document.form_version IS NULL THEN
    RETURN 'scan_unusable';
  END IF;
  IF p_participation.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RETURN 'participation_closed';
  END IF;
  IF p_participation.placement_agentur_key IS DISTINCT FROM p_agentur_key THEN
    RETURN 'placement_agentur_changed';
  END IF;
  SELECT channel INTO v_channel FROM public.asu_record WHERE participation_id = p_participation.id;
  IF p_member.batch_id IS NULL THEN
    IF EXISTS (SELECT FROM public.kug200b_batch_member m
               JOIN public.kug200b_batch b ON b.id = m.batch_id AND b.status = 'open'
               WHERE m.participation_id = p_participation.id AND m.active) THEN
      RETURN 'in_open_batch';
    END IF;
    IF EXISTS (SELECT FROM public.agentur_submission s
               WHERE s.participation_id = p_participation.id AND s.form_code = 'kug200b') THEN
      RETURN 'already_submitted';
    END IF;
    IF v_channel IS NULL THEN
      RETURN 'asu_route_unset';
    END IF;
  ELSIF v_channel IS DISTINCT FROM p_member.asu_channel THEN
    RETURN 'asu_route_changed';
  END IF;
  IF v_channel = 'kug_200b' AND EXISTS (
       SELECT FROM public.asu_registration WHERE participation_id = p_participation.id) THEN
    RETURN 'asu_registered';
  END IF;
  IF p_document.form_version = ANY (p_outdated_versions) THEN
    RETURN 'form_version_outdated';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- A batch's recheck (D25), under the exclusive lock its caller holds: the channel and the artifact
-- as resolved now (`settings_changed`, one batch-level row), then each member's problem; its
-- participation rows locked in UUID order and its scans in id order first. The rows, as the
-- domain's `Kug200bBatchStaleRow` writes them; an empty array when the batch is current.
CREATE FUNCTION kug200b_batch_recheck(
  p_batch kug200b_batch, p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact,
  p_outdated_versions text[]
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m public.kug200b_batch_member;
  r public.participation;
  d public.document;
  v_problem text;
  v_rows jsonb := '[]';
BEGIN
  PERFORM FROM public.participation p
  WHERE p.id IN (SELECT participation_id FROM public.kug200b_batch_member
                 WHERE batch_id = p_batch.id)
  ORDER BY p.id FOR UPDATE;
  PERFORM FROM public.document x
  WHERE x.id IN (SELECT document_id FROM public.kug200b_batch_member WHERE batch_id = p_batch.id)
  ORDER BY x.id FOR SHARE;
  IF p_channel IS DISTINCT FROM p_batch.channel OR p_artifact IS DISTINCT FROM p_batch.artifact THEN
    RETURN pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('participationId', NULL,
      'documentId', NULL, 'reason', 'settings_changed'));
  END IF;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = p_batch.id
           ORDER BY participation_id LOOP
    SELECT * INTO r FROM public.participation WHERE id = m.participation_id;
    SELECT * INTO d FROM public.document WHERE id = m.document_id;
    v_problem := public.kug200b_member_problem(r, d, p_batch.agentur_key,
      coalesce(p_outdated_versions, '{}'), m);
    IF v_problem IS NOT NULL THEN
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'participationId', m.participation_id, 'documentId', m.document_id, 'reason', v_problem));
    END IF;
  END LOOP;
  RETURN v_rows;
END $$;
--> statement-breakpoint

-- The batch an operation names, its project locked as `lock_kug200b_batch_project` does: a batch
-- that doesn't exist or isn't the user's to lead is `batch_not_found`. Returns it locked.
CREATE FUNCTION lock_kug200b_batch(p_context audit_context, p_batch_id uuid)
RETURNS kug200b_batch LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id FROM public.kug200b_batch WHERE id = p_batch_id;
  IF NOT FOUND THEN
    PERFORM public.assert_context(p_context, NULL, '{user}');
    RAISE EXCEPTION 'batch_not_found';
  END IF;
  PERFORM public.lock_kug200b_batch_project(p_context, v_project_id, 'batch_not_found');
  SELECT * INTO b FROM public.kug200b_batch WHERE id = p_batch_id;
  RETURN b;
END $$;
--> statement-breakpoint

-- A live export link of this staff user and session (data-protection.md, exports), not expired,
-- the session live and the account active, never in assisted mode; else `export_link_invalid`
-- (a 404).
CREATE FUNCTION live_export_link(p_context audit_context, p_link_hash text, p_session_hash text)
RETURNS export_link LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
BEGIN
  IF p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  SELECT * INTO l FROM public.export_link e
  WHERE e.token_hash = p_link_hash AND e.session_hash = p_session_hash
    AND e.staff_user_id = (p_context).staff_user_id AND e.expires_at > now()
    AND (p_context).on_behalf_of IS NULL
    AND EXISTS (
      SELECT FROM public.staff_session s
      JOIN public.staff_user u ON u.id = s.staff_user_id
      WHERE s.token_hash = p_session_hash AND s.staff_user_id = e.staff_user_id
        AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  RETURN l;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- A batch built (process-and-lifecycle.md, Kug 200b batches; D25): the PL of a `ta_tg` project,
-- for one placement Agentur, with the channel and the artifact the API resolved under this lock (no
-- channel: `batch_settings_missing`, the step blocker, Q91) and the versions the Agentur rejects
-- as outdated; 1–200 distinct accepted Kug 200b scans of the project, at most one per
-- participation (`invalid_argument`). A scan id that isn't the project's is `document_not_found`
-- whatever its state. Any scan with a problem refuses the whole batch with its rows
-- (`batch_stale`): all or nothing, its membership fixed. Each member keeps its route and
-- placement Agentur as read now. Audited `kug200b_batch_created` (project-level). Returns the id.
CREATE FUNCTION create_kug200b_batch(
  p_context audit_context, p_project_id uuid, p_batch_id uuid, p_agentur_key text,
  p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact, p_document_ids uuid[],
  p_outdated_versions text[]
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  r public.participation;
  v_problem text;
  v_rows jsonb := '[]';
  v_count integer := pg_catalog.cardinality(p_document_ids);
BEGIN
  IF p_project_id IS NULL OR p_batch_id IS NULL OR p_artifact IS NULL
     OR p_agentur_key IS NULL OR p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR p_document_ids IS NULL OR v_count NOT BETWEEN 1 AND 200
     OR pg_catalog.array_position(p_document_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_document_ids) i) <> v_count
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.lock_kug200b_batch_project(p_context, p_project_id, 'project_not_found');
  IF p_channel IS NULL THEN
    RAISE EXCEPTION 'batch_settings_missing';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE id = ANY (p_document_ids) AND project_id = p_project_id) <> v_count THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT participation_id) FROM public.document
      WHERE id = ANY (p_document_ids)) <> v_count THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM FROM public.participation p
  WHERE p.id IN (SELECT participation_id FROM public.document WHERE id = ANY (p_document_ids))
  ORDER BY p.id FOR UPDATE;
  PERFORM FROM public.document WHERE id = ANY (p_document_ids) ORDER BY id FOR SHARE;
  FOR d IN SELECT * FROM public.document WHERE id = ANY (p_document_ids)
           ORDER BY participation_id LOOP
    SELECT * INTO r FROM public.participation WHERE id = d.participation_id;
    v_problem := public.kug200b_member_problem(r, d, p_agentur_key, p_outdated_versions, NULL);
    IF v_problem IS NOT NULL THEN
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'participationId', r.id, 'documentId', d.id, 'reason', v_problem));
    END IF;
  END LOOP;
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  INSERT INTO public.kug200b_batch (id, project_id, agentur_key, channel, artifact, member_count,
    created_by)
  VALUES (p_batch_id, p_project_id, p_agentur_key, p_channel, p_artifact, v_count,
    (p_context).staff_user_id);
  INSERT INTO public.kug200b_batch_member (batch_id, project_id, participation_id, document_id,
    form_version, asu_channel, placement_agentur_key)
  SELECT p_batch_id, p_project_id, x.participation_id, x.id, x.form_version, a.channel,
    p_agentur_key
  FROM public.document x
  LEFT JOIN public.asu_record a ON a.participation_id = x.participation_id
  WHERE x.id = ANY (p_document_ids);
  PERFORM public.write_audit_event(p_project_id, NULL, 'kug200b_batch_created', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', p_batch_id,
      'agenturKey', p_agentur_key, 'channel', p_channel, 'artifact', p_artifact,
      'count', v_count), false);
  RETURN p_batch_id;
END $$;
--> statement-breakpoint

-- An open batch discarded by its PL (`batch_not_open` once submitted or discarded): its members
-- are free for a new batch; the row and its membership stay as history. Audited
-- `kug200b_batch_discarded`.
CREATE FUNCTION discard_kug200b_batch(p_context audit_context, p_batch_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  PERFORM FROM public.kug200b_batch WHERE id = b.id FOR UPDATE;
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  UPDATE public.kug200b_batch SET status = 'discarded',
    discarded_by = (p_context).staff_user_id, discarded_at = now()
  WHERE id = b.id;
  UPDATE public.kug200b_batch_member SET active = false WHERE batch_id = b.id;
  PERFORM public.write_audit_event(b.project_id, NULL, 'kug200b_batch_discarded', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', b.id,
      'count', b.member_count), false);
END $$;
--> statement-breakpoint

-- "Übermittelt am" (process-and-lifecycle.md, Kug 200b batches; D19, D25): the PL records the
-- actual sent date of an open batch (`batch_not_open`), not after today in Berlin
-- (`submitted_on_in_future`) and not before the batch's Berlin day (`submitted_before_batch`),
-- after the recheck under the exclusive lock with the channel, artifact and outdated versions the
-- API resolved now (any row: `batch_stale` with the rows, nothing written; the PL discards and
-- rebuilds). Then, in member order, each member's `agentur_submission` (audited
-- `agentur_submission_recorded`) and, on the route `kug_200b`, its ASU registration: the
-- submission is the registration and its proof, `registered_on` the sent date, the complete fact
-- recorded now (audited `asu_registration_recorded`). A member that has become terminal makes the
-- batch stale, so it never gets a registration. Audited `kug200b_batch_submitted`. Returns the
-- counts.
CREATE FUNCTION submit_kug200b_batch(
  p_context audit_context, p_batch_id uuid, p_submitted_on date,
  p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact, p_outdated_versions text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  m public.kug200b_batch_member;
  v_rows jsonb;
  v_submission_id uuid;
  v_registration_id uuid;
  v_registrations integer := 0;
BEGIN
  IF p_batch_id IS NULL OR p_submitted_on IS NULL OR p_artifact IS NULL
     OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  IF p_submitted_on > public.berlin_today() THEN
    RAISE EXCEPTION 'submitted_on_in_future';
  END IF;
  IF p_submitted_on < (b.created_at AT TIME ZONE 'Europe/Berlin')::date THEN
    RAISE EXCEPTION 'submitted_before_batch';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  PERFORM FROM public.kug200b_batch WHERE id = b.id FOR UPDATE;
  UPDATE public.kug200b_batch SET status = 'submitted', submitted_on = p_submitted_on,
    submitted_by = (p_context).staff_user_id, submitted_at = now()
  WHERE id = b.id;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id
           ORDER BY participation_id LOOP
    v_submission_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.agentur_submission (id, project_id, participation_id, document_id,
      form_code, form_version, agentur_key, channel, batch_id, submitted_on, recorded_by)
    VALUES (v_submission_id, b.project_id, m.participation_id, m.document_id, 'kug200b',
      m.form_version, b.agentur_key, b.channel::text::public.agentur_submission_channel, b.id,
      p_submitted_on, (p_context).staff_user_id);
    PERFORM public.write_audit_event(b.project_id, m.participation_id,
      'agentur_submission_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('submissionId', v_submission_id, 'documentId', m.document_id,
        'formCode', 'kug200b', 'formVersion', m.form_version, 'channel', b.channel,
        'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'), 'batchId', b.id), false);
    IF m.asu_channel = 'kug_200b' THEN
      v_registration_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.asu_registration (id, project_id, participation_id, channel,
        registered_on, recorded_by, proof_kind, proof_linked_by, proof_linked_at,
        agentur_submission_id)
      VALUES (v_registration_id, b.project_id, m.participation_id, 'kug_200b', p_submitted_on,
        (p_context).staff_user_id, 'kug200b_submission', (p_context).staff_user_id, now(),
        v_submission_id);
      PERFORM public.write_audit_event(b.project_id, m.participation_id,
        'asu_registration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('registrationId', v_registration_id,
          'channel', 'kug_200b', 'registeredOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'),
          'proofKind', 'kug200b_submission'), false);
      v_registrations := v_registrations + 1;
    END IF;
  END LOOP;
  PERFORM public.write_audit_event(b.project_id, NULL, 'kug200b_batch_submitted', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', b.id,
      'submittedOn', pg_catalog.to_char(p_submitted_on, 'YYYY-MM-DD'),
      'count', b.member_count, 'registrations', v_registrations), false);
  RETURN pg_catalog.jsonb_build_object('submissions', b.member_count,
    'registrations', v_registrations);
END $$;
--> statement-breakpoint

-- "Bestätigung der Agentur am" (process-and-lifecycle.md, Arbeitsuchendmeldung; D19): the PL of a
-- `ta_tg` participation (the API checks its visibility first) records the Agentur's confirmation of
-- a batch's registration, also after the end: on the route `kug_200b` only
-- (`asu_not_kug200b`), once (`asu_confirmed`), not after today in Berlin
-- (`confirmed_on_in_future`) and not before the submission (`confirmed_before_submission`). It is
-- follow-up work and never a condition of the registration. Audited `asu_confirmation_recorded`.
CREATE FUNCTION record_asu_confirmation(
  p_context audit_context, p_participation_id uuid, p_registration_id uuid, p_confirmed_on date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  g public.asu_registration;
BEGIN
  IF p_participation_id IS NULL OR p_registration_id IS NULL OR p_confirmed_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  SELECT * INTO g FROM public.asu_registration
  WHERE id = p_registration_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asu_registration_not_found';
  END IF;
  IF g.channel <> 'kug_200b' THEN
    RAISE EXCEPTION 'asu_not_kug200b';
  END IF;
  IF g.confirmed_on IS NOT NULL THEN
    RAISE EXCEPTION 'asu_confirmed';
  END IF;
  IF p_confirmed_on > public.berlin_today() THEN
    RAISE EXCEPTION 'confirmed_on_in_future';
  END IF;
  IF p_confirmed_on < g.registered_on THEN
    RAISE EXCEPTION 'confirmed_before_submission';
  END IF;
  UPDATE public.asu_registration SET confirmed_on = p_confirmed_on,
    confirmed_by = (p_context).staff_user_id, confirmed_at = now()
  WHERE id = g.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_confirmation_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('registrationId', g.id,
      'confirmedOn', pg_catalog.to_char(p_confirmed_on, 'YYYY-MM-DD')), false);
END $$;
--> statement-breakpoint

-- The route (process-and-lifecycle.md, Arbeitsuchendmeldung), as 0074 wrote it, and once the
-- participation's Kug 200b was submitted in a batch on another route, never `kug_200b`
-- (`asu_kug200b_submitted`, Q203): that submission recorded no registration and can't be
-- repeated, so the person registers on the route they are on.
CREATE OR REPLACE FUNCTION set_asu_route(
  p_context audit_context, p_participation_id uuid, p_channel asu_channel, p_version integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  a public.asu_record;
BEGIN
  IF p_participation_id IS NULL OR p_channel IS NULL OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{project_lead,consultant}');
  SELECT * INTO a FROM public.asu_record WHERE participation_id = r.id FOR UPDATE;
  IF coalesce(a.version, 0) <> p_version THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'asu_registered';
  END IF;
  IF a.channel IS NOT DISTINCT FROM p_channel THEN
    RETURN p_version;
  END IF;
  IF p_channel = 'kug_200b' AND EXISTS (
       SELECT FROM public.agentur_submission
       WHERE participation_id = r.id AND form_code = 'kug200b') THEN
    RAISE EXCEPTION 'asu_kug200b_submitted';
  END IF;
  INSERT INTO public.asu_record (participation_id, project_id, channel, version, set_by)
  VALUES (r.id, r.project_id, p_channel, 1, (p_context).staff_user_id)
  ON CONFLICT (participation_id) DO UPDATE SET channel = EXCLUDED.channel,
    version = public.asu_record.version + 1, set_by = EXCLUDED.set_by, set_at = now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_route_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'channel', p_channel, 'previousChannel', a.channel)), false);
  RETURN p_version + 1;
END $$;
--> statement-breakpoint

-- A batch's export issued (data-protection.md, exports; D24): the staff user's live session
-- (`session_invalid`), the batch visible to its PL (`batch_not_found` whatever its state), not in
-- assisted mode (`actor_not_allowed`), open (`batch_not_open`) and rechecked under the exclusive
-- lock with what the API resolved now (`batch_stale` with the rows). Stores the link's hash bound
-- to the session, valid 60 s, the batch fixed; no file. Audited `export_created` (kind and count,
-- project-level). Returns the expiry.
CREATE FUNCTION create_kug200b_batch_export_link(
  p_context audit_context, p_kind export_kind, p_batch_id uuid, p_session_hash text,
  p_link_hash text, p_channel kug200b_batch_channel, p_artifact kug200b_batch_artifact,
  p_outdated_versions text[]
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.kug200b_batch;
  v_rows jsonb;
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_kind IS NULL OR p_kind::text <> 'kug200b_batch_index' OR p_batch_id IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_artifact IS NULL OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  INSERT INTO public.export_link (token_hash, project_id, kind, document_ids, batch_id,
    staff_user_id, session_hash, expires_at)
  VALUES (p_link_hash, b.project_id, p_kind, '{}', b.id, (p_context).staff_user_id,
    p_session_hash, v_expires);
  PERFORM public.write_audit_event(b.project_id, NULL, 'export_created', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', p_kind,
      'count', b.member_count), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- The kind of a live link of this staff user and session (`export_link_invalid` otherwise), so the
-- API reads its content through the kind's own function. Reads nothing else; not audited.
CREATE FUNCTION export_link_kind(p_context audit_context, p_link_hash text, p_session_hash text)
RETURNS export_kind LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (public.live_export_link(p_context, p_link_hash, p_session_hash)).kind;
END $$;
--> statement-breakpoint

-- A print file's content, as 0076 wrote it, through `live_export_link`; a batch's link is not
-- one (`export_link_invalid`).
CREATE OR REPLACE FUNCTION export_link_content(
  p_context audit_context, p_link_hash text, p_session_hash text
) RETURNS TABLE (
  document_id uuid, participation_id uuid, document_type document_type, key_id text,
  wrapped_key bytea
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.kind::text <> 'kug200b_print' THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  FOR d IN SELECT x.* FROM public.document x WHERE x.id = ANY (l.document_ids) LOOP
    IF NOT public.export_document_allowed(d, l.staff_user_id) THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM public.document x WHERE x.id = ANY (l.document_ids))
     <> pg_catalog.cardinality(l.document_ids) THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', pg_catalog.cardinality(l.document_ids)), false);
  RETURN QUERY
    SELECT x.id, x.participation_id, x.type, x.key_id, x.wrapped_key
    FROM pg_catalog.unnest(l.document_ids) WITH ORDINALITY AS u(id, ord)
    JOIN public.document x ON x.id = u.id
    ORDER BY u.ord;
END $$;
--> statement-breakpoint

-- A batch export's content (data-protection.md, exports; D24): a live link of a batch kind
-- (`export_link_invalid`), **re-authorized** now under the exclusive lock: the user still the
-- project's PL, the batch still open and every member still usable, open, placed with the
-- batch's Agentur and on its route (`export_stale`; the settings were rechecked at the request).
-- The members in the index's order (last name, first name), the values read in this one locked
-- snapshot; the API renders and streams the CSV and stores nothing. Audited `export_downloaded`.
CREATE FUNCTION kug200b_batch_export_content(
  p_context audit_context, p_link_hash text, p_session_hash text
) RETURNS TABLE (
  participation_id uuid, document_id uuid, last_name text, first_name text, form_version text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  l public.export_link;
  b public.kug200b_batch;
  m public.kug200b_batch_member;
  r public.participation;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(l.project_id));
  SELECT * INTO b FROM public.kug200b_batch WHERE id = l.batch_id;
  IF NOT public.kug200b_batch_lead(b.project_id, l.staff_user_id) OR b.status <> 'open' THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id LOOP
    SELECT * INTO r FROM public.participation WHERE id = m.participation_id;
    SELECT * INTO d FROM public.document WHERE id = m.document_id;
    IF public.kug200b_member_problem(r, d, b.agentur_key, '{}', m) IS NOT NULL THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', b.member_count), false);
  RETURN QUERY
    SELECT m2.participation_id, m2.document_id, i.last_name, i.first_name, m2.form_version
    FROM public.kug200b_batch_member m2
    LEFT JOIN public.participant_identity i ON i.participation_id = m2.participation_id
    WHERE m2.batch_id = b.id
    ORDER BY i.last_name, i.first_name, m2.participation_id;
END $$;
--> statement-breakpoint

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
      'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
      'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
      'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set',
      'kug200b_offer_declined', 'declaration_withdrawal_recorded',
      'declaration_withdrawal_ba_notified', 'export_created', 'export_downloaded',
      'kug200b_batch_created', 'kug200b_batch_submitted', 'kug200b_batch_discarded',
      'agentur_submission_recorded', 'asu_confirmation_recorded') THEN
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

-- Grants: transfer_app selects the batches, their members and the submissions (ids, codes, dates;
-- no ciphertext) and writes none; it has no privilege on the export links; it executes the batch
-- functions, the confirmation and the batch export's two, and the link's kind.
GRANT SELECT ON TABLE kug200b_batch, kug200b_batch_member, agentur_submission TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kug200b_batch_lead, lock_kug200b_batch_project, kug200b_member_problem,
  kug200b_batch_recheck, lock_kug200b_batch, live_export_link, create_kug200b_batch,
  discard_kug200b_batch, submit_kug200b_batch, record_asu_confirmation,
  create_kug200b_batch_export_link, export_link_kind, kug200b_batch_export_content
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_kug200b_batch, discard_kug200b_batch, submit_kug200b_batch,
  record_asu_confirmation, create_kug200b_batch_export_link, export_link_kind,
  kug200b_batch_export_content TO transfer_app;
