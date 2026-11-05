-- Hand-written (ADR-0002, evidence corrections; data-protection.md, evidence corrections;
-- process-and-lifecycle.md, Arbeitsuchendmeldung and BA reporting; D29, Q183, Q186, Q190, Q207 (6);
-- readings Q209): the PL's request to correct one piece of wrong evidence, the regional operations
-- manager's decision (four eyes) applying it, and what the rest of the schema must respect once
-- evidence can be invalidated or superseded. Same hardening as 0086: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, database time, refusals as P0001 with a stable code, never a
-- value. The enums and event types 0087 added are compared as text here, since this runs after it
-- in the same migration run.
--
-- Lock order (ADR-0002, D31): a request takes the project's shared advisory lock and the
-- participation row (`lock_participation`), then its target (the document, the ASU registration or
-- the BA reporting task) `FOR UPDATE`, then writes the correction. A decision takes the project's
-- exclusive advisory lock first, then the participation row, the target, then the correction row.
-- No setting is read: nothing to resolve.
--
-- The upgrade of an existing database: no row names a correction yet; a document invalidated
-- before corrections existed keeps its value under 0087's NOT VALID foreign key and still counts
-- nothing. ASU registrations and BA reporting tasks stay as they are (all current, none
-- superseded).

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
    'asu_confirmation_recorded', 'agentur_submission_original_sent',
    'agentur_submission_rejected', 'agentur_submission_original_retained',
    'ba_report_recorded', 'exception_evidence_recorded',
    'evidence_correction_requested', 'evidence_correction_decided'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): in the `case` stream, by the
-- target's kind, the action, the reason code and the decision; never the source or a value.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('evidence_correction_requested', NULL, 'case', false, false, '{targetKind,action,reason}'),
  ('evidence_correction_decided', NULL, 'case', false, false,
    '{targetKind,action,reason,decision}');
--> statement-breakpoint

-- The field catalog's new key (the history's field categories): the correction's codes, dates and
-- source.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('evidenceCorrection', 'case_internal');
--> statement-breakpoint

-- Append-only (data-protection.md, evidence corrections), whoever writes: never deleted; only a
-- pending request's decision is written, once, and nothing else of it changes.
CREATE FUNCTION evidence_correction_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status::text <> 'requested' OR NEW.status::text = 'requested'
     OR (NEW.id, NEW.project_id, NEW.participation_id, NEW.target_kind, NEW.action,
         NEW.document_id, NEW.asu_registration_id, NEW.ba_reporting_task_id, NEW.wrong_person,
         NEW.corrected_registered_on, NEW.reason, NEW.source, NEW.retention_class,
         NEW.requested_by, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.project_id, OLD.participation_id, OLD.target_kind, OLD.action,
         OLD.document_id, OLD.asu_registration_id, OLD.ba_reporting_task_id, OLD.wrong_person,
         OLD.corrected_registered_on, OLD.reason, OLD.source, OLD.retention_class,
         OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'correction_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER evidence_correction_append_only BEFORE UPDATE OR DELETE
  ON public.evidence_correction
  FOR EACH ROW EXECUTE FUNCTION public.evidence_correction_append_only();
--> statement-breakpoint

-- A BA reporting task (0032) still only moves forward: from `pending` to its outcome once; a
-- closed one only gains, once, the replacement task an approved correction created
-- (`superseded_by`), its outcome unchanged (Q190, Q207 (6)). What it reports never changes.
CREATE OR REPLACE FUNCTION ba_reporting_task_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  IF (NEW.id, NEW.participation_id, NEW.project_id, NEW.reporting_kind, NEW.subject_date,
      NEW.amendment_id, NEW.created_at, NEW.replaces_task_id, NEW.correction_id)
     IS DISTINCT FROM
     (OLD.id, OLD.participation_id, OLD.project_id, OLD.reporting_kind, OLD.subject_date,
      OLD.amendment_id, OLD.created_at, OLD.replaces_task_id, OLD.correction_id) THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  IF OLD.status::text = 'pending' THEN
    IF NEW.status::text NOT IN ('reported', 'not_required') OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'task_immutable';
    END IF;
  ELSIF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
     OR (NEW.status, NEW.reported_on, NEW.not_required_reason, NEW.decided_by, NEW.decided_at,
         NEW.channel, NEW.reference)
       IS DISTINCT FROM
       (OLD.status, OLD.reported_on, OLD.not_required_reason, OLD.decided_by, OLD.decided_at,
         OLD.channel, OLD.reference) THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- The documented source as stored (the domain's `normaliseCorrectionSource`): tabs as spaces, null
-- for any other control character, NFC, inner runs of white space as one, trimmed; null if nothing
-- is left.
CREATE FUNCTION normalise_correction_source(p_source text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_source IS NULL
      OR pg_catalog.replace(p_source, E'\t', ' ') ~ '[[:cntrl:]]' THEN NULL
    ELSE NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.normalize(p_source, 'NFC'),
      '\s+', ' ', 'g')), '') END
$$;
--> statement-breakpoint

-- The route (0078) is fixed while a current registration exists: after an approved invalidation
-- the PL records the registration again, on the same or another route.
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
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id
      AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
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

-- A registration (0074) is refused only beside a current one (`asu_registered`); superseded and
-- invalidated ones stay as history.
CREATE OR REPLACE FUNCTION record_asu_registration(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_registered_on date,
  p_route_version integer, p_customer_number text DEFAULT NULL,
  p_attestation_source asu_attestation_source DEFAULT NULL, p_key text DEFAULT NULL,
  p_key_id text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  a public.asu_record;
  v_channel public.asu_channel;
  v_attested boolean := p_customer_number IS NOT NULL;
  v_number text := pg_catalog.upper(pg_catalog.btrim(p_customer_number));
  v_key_id text;
BEGIN
  IF p_participation_id IS NULL OR p_id IS NULL OR p_registered_on IS NULL
     OR p_route_version IS NULL OR v_attested <> (p_attestation_source IS NOT NULL)
     OR v_attested AND (v_number !~ '^[0-9A-Z]{4,20}$'
       OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
       OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context,
    CASE WHEN v_attested THEN '{project_lead}' ELSE '{project_lead,consultant}' END::text[]);
  SELECT * INTO a FROM public.asu_record WHERE participation_id = r.id FOR SHARE;
  v_channel := a.channel;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'asu_route_unset';
  END IF;
  IF a.version <> p_route_version THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF v_channel = 'kug_200b' THEN
    RAISE EXCEPTION 'asu_route_kug200b';
  END IF;
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id
      AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
    RAISE EXCEPTION 'asu_registered';
  END IF;
  IF p_registered_on > public.berlin_today() THEN
    RAISE EXCEPTION 'registered_on_in_future';
  END IF;
  INSERT INTO public.asu_registration (id, project_id, participation_id, channel, registered_on,
    recorded_by, proof_kind, attestation_source, proof_linked_by, proof_linked_at)
  VALUES (p_id, r.project_id, r.id, v_channel, p_registered_on, (p_context).staff_user_id,
    CASE WHEN v_attested THEN 'ba_customer_number'::public.asu_proof_kind END,
    p_attestation_source,
    CASE WHEN v_attested THEN (p_context).staff_user_id END,
    CASE WHEN v_attested THEN now() END);
  IF v_attested THEN
    SELECT key_id INTO v_key_id FROM public.participant_identifier_data
    WHERE participation_id = r.id FOR UPDATE;
    IF v_key_id IS DISTINCT FROM p_key_id AND v_key_id IS NOT NULL THEN
      RAISE EXCEPTION 'key_unknown';
    END IF;
    INSERT INTO public.participant_identifier_data (participation_id, project_id,
      ba_customer_number, ba_customer_number_present, key_id)
    VALUES (r.id, r.project_id, public.seal_sensitive_value(r.id, 'baCustomerNumber',
      pg_catalog.to_jsonb(v_number), p_key), true, p_key_id)
    ON CONFLICT (participation_id) DO UPDATE SET
      ba_customer_number = EXCLUDED.ba_customer_number, ba_customer_number_present = true,
      written_at = now();
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'baCustomerNumber'), false);
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_registration_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'registrationId', p_id, 'channel', v_channel,
      'registeredOn', pg_catalog.to_char(p_registered_on, 'YYYY-MM-DD'),
      'proofKind', CASE WHEN v_attested THEN 'ba_customer_number' END,
      'attestationSource', p_attestation_source)), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- A proof (0074) is linked to a current registration only (`asu_registration_corrected`).
CREATE OR REPLACE FUNCTION link_asu_proof(
  p_context audit_context, p_participation_id uuid, p_registration_id uuid, p_document_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
BEGIN
  IF p_participation_id IS NULL OR p_registration_id IS NULL OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{consultant}');
  SELECT * INTO d FROM public.document
  WHERE id = p_document_id AND participation_id = r.id AND type = 'asu_proof'
    AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  IF d.review_state <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  SELECT * INTO g FROM public.asu_registration
  WHERE id = p_registration_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asu_registration_not_found';
  END IF;
  IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
    RAISE EXCEPTION 'asu_registration_corrected';
  END IF;
  IF g.proof_kind IS NOT NULL THEN
    RAISE EXCEPTION 'asu_proof_present';
  END IF;
  UPDATE public.asu_registration SET proof_kind = 'ba_confirmation', proof_document_id = d.id,
    proof_linked_by = (p_context).staff_user_id, proof_linked_at = now()
  WHERE id = g.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_proof_linked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('registrationId', g.id, 'documentId', d.id),
    false);
END $$;
--> statement-breakpoint

-- The Agentur's confirmation (0078) is recorded on a current registration only.
CREATE OR REPLACE FUNCTION record_asu_confirmation(
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
  IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
    RAISE EXCEPTION 'asu_registration_corrected';
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

-- A batch member (0078) is refused beside a current registration only.
CREATE OR REPLACE FUNCTION kug200b_member_problem(
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
       SELECT FROM public.asu_registration WHERE participation_id = p_participation.id
         AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
    RETURN 'asu_registered';
  END IF;
  IF p_document.form_version = ANY (p_outdated_versions) THEN
    RETURN 'form_version_outdated';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- The ordinary opening (0072) refuses an invalidated document (data-protection.md, evidence
-- corrections; Q200): it opens for nobody, break-glass aside.
CREATE OR REPLACE FUNCTION open_document(
  p_context audit_context, p_document_id uuid, p_session_kind document_session_kind,
  p_session_hash text, p_link_hash text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_roles text[];
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_document_id IS NULL OR p_session_kind IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO d FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, d.participation_id, '{participant,user}');
  IF ((p_context).actor_type = 'participant') <> (p_session_kind = 'participant') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL THEN
    PERFORM FROM public.staff_session s
    JOIN public.staff_user u ON u.id = s.staff_user_id
    WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
      AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
  END IF;
  v_roles := public.lock_document_actor(d.participation_id, p_context, p_session_hash, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.open_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  INSERT INTO public.document_link (token_hash, document_id, project_id, participation_id,
    session_kind, session_hash, expires_at)
  VALUES (p_link_hash, d.id, d.project_id, d.participation_id, p_session_kind, p_session_hash,
    v_expires);
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_opened', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentType', d.type, 'documentId', d.id), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- A link opened before an invalidation answers nothing (0076), as for a quarantine.
CREATE OR REPLACE FUNCTION document_link_content(
  p_link_hash text, p_session_kind document_session_kind, p_session_hash text
) RETURNS TABLE (
  document_id uuid, participation_id uuid, document_type document_type,
  media_type document_media_type, file_name text, key_id text, wrapped_key bytea,
  added_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT d.id, d.participation_id, d.type, d.media_type, d.file_name, d.key_id, d.wrapped_key,
    d.added_at
  FROM public.document_link l
  JOIN public.document d ON d.id = l.document_id
  WHERE l.token_hash = p_link_hash AND l.session_kind = p_session_kind
    AND l.session_hash = p_session_hash AND l.expires_at > now() AND d.deleted_at IS NULL
    AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
    AND CASE p_session_kind
      WHEN 'participant' THEN EXISTS (
        SELECT FROM public.participant_session s
        WHERE s.token_hash = p_session_hash AND s.state = 'active'
          AND public.participant_session_live(s))
      ELSE EXISTS (
        SELECT FROM public.staff_session s
        JOIN public.staff_user u ON u.id = s.staff_user_id
        WHERE s.token_hash = p_session_hash AND s.ended_at IS NULL AND s.expires_at > now()
          AND u.deactivated_at IS NULL)
    END
$$;
--> statement-breakpoint

-- An invalidated document (0074) isn't quarantined again: it already counts nothing.
CREATE OR REPLACE FUNCTION quarantine_document(
  p_context audit_context, p_document_id uuid, p_reason document_quarantine_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT quarantine_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  UPDATE public.document SET quarantine_reason = p_reason,
    quarantined_by = (p_context).staff_user_id, quarantined_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_quarantined',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- A quarantine (0074) isn't lifted while a correction of the document is pending
-- (`correction_pending`, data-protection.md, quarantine) or once it is invalidated.
CREATE OR REPLACE FUNCTION lift_document_quarantine(p_context audit_context, p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT quarantine_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version)
     OR d.quarantined_by IS DISTINCT FROM (p_context).staff_user_id
       AND NOT 'project_lead' = ANY (v_roles) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NULL THEN
    RAISE EXCEPTION 'document_not_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  IF EXISTS (SELECT FROM public.evidence_correction
             WHERE document_id = d.id AND status::text = 'requested') THEN
    RAISE EXCEPTION 'correction_pending';
  END IF;
  UPDATE public.document SET quarantine_reason = NULL, quarantined_by = NULL,
    quarantined_at = NULL, quarantine_lifted_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id,
    'document_quarantine_lifted', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- `record_audit_event` (0086) refuses the new types: only their functions write them.
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
      'agentur_submission_recorded', 'asu_confirmation_recorded',
      'agentur_submission_original_sent', 'agentur_submission_rejected',
      'agentur_submission_original_retained', 'ba_report_recorded',
      'exception_evidence_recorded', 'evidence_correction_requested',
      'evidence_correction_decided') THEN
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

-- The request (data-protection.md, evidence corrections; D29): a staff user acting as themselves
-- (`actor_not_allowed` on behalf of a participant) of the correction-authority table's roles for the
-- target (the PL; for the DSV and its cancellation also back office; nobody for a generated working
-- copy) asks to correct one target of the participation (`target_not_found` for any other id):
-- - `document` / `invalidate`: an accepted, live document (`document_not_accepted`), stating
--   whether it is a wrong person's file;
-- - `asu_registration` / `invalidate`, or `supersede` with the corrected actual registration date
--   (not after today in Berlin, `registered_on_in_future`; not the recorded one,
--   `correction_unchanged`; not on the route `kug_200b`, whose date is the batch's,
--   `asu_route_kug200b`): a current registration;
-- - `ba_reporting_task` / `supersede`: a closed task (`task_pending` while it is pending).
-- A target already invalidated or superseded is `target_corrected`, one with a pending request
-- `correction_pending`. The reason code and the documented source (normalised, 1 to 200
-- characters, one line; `source_invalid`) are required; any other shape is `invalid_argument`.
-- Closed participations are corrected too: evidence outlives the end. Audited
-- `evidence_correction_requested` with codes only. Changes nothing else.
CREATE FUNCTION request_evidence_correction(
  p_context audit_context, p_participation_id uuid, p_target_kind correction_target_kind,
  p_action correction_action, p_target_id uuid, p_wrong_person boolean,
  p_corrected_registered_on date, p_reason correction_reason, p_source text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_shape_ok boolean := CASE p_target_kind::text
    WHEN 'document' THEN p_action::text = 'invalidate' AND p_wrong_person IS NOT NULL
      AND p_corrected_registered_on IS NULL
    WHEN 'asu_registration' THEN p_wrong_person IS NULL
      AND (p_action::text = 'supersede') = (p_corrected_registered_on IS NOT NULL)
    WHEN 'ba_reporting_task' THEN p_action::text = 'supersede' AND p_wrong_person IS NULL
      AND p_corrected_registered_on IS NULL
    ELSE false END;
  v_source text := public.normalise_correction_source(p_source);
  v_roles text[];
  v_requesters text[] := '{project_lead}';
  v_corrected boolean;
  v_class text := 'participation_record';
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_participation_id IS NULL OR p_target_id IS NULL OR p_reason IS NULL
     OR NOT coalesce(v_shape_ok, false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'source_invalid';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  v_roles := public.document_staff_roles(r.id, (p_context).staff_user_id);
  IF p_target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document
    WHERE id = p_target_id AND participation_id = r.id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_requesters := CASE
      WHEN d.type::text IN ('dsv_signed_scan', 'dsv_cancellation') THEN '{project_lead,back_office}'
      WHEN d.type::text IN ('tl407_form', 'kug200b_form') THEN '{}'
      ELSE '{project_lead}' END::text[];
    v_corrected := d.invalidated_by_correction IS NOT NULL;
    v_class := d.retention_class;
  ELSIF p_target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL;
  ELSE
    SELECT * INTO t FROM public.ba_reporting_task
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := t.superseded_by IS NOT NULL;
  END IF;
  IF NOT v_roles && v_requesters THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF v_corrected THEN
    RAISE EXCEPTION 'target_corrected';
  END IF;
  IF EXISTS (SELECT FROM public.evidence_correction
             WHERE coalesce(document_id, asu_registration_id, ba_reporting_task_id) = p_target_id
               AND status::text = 'requested') THEN
    RAISE EXCEPTION 'correction_pending';
  END IF;
  IF p_target_kind::text = 'document' AND d.review_state::text <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  IF p_target_kind::text = 'ba_reporting_task' AND t.status::text = 'pending' THEN
    RAISE EXCEPTION 'task_pending';
  END IF;
  IF p_corrected_registered_on IS NOT NULL THEN
    IF g.channel::text = 'kug_200b' THEN
      RAISE EXCEPTION 'asu_route_kug200b';
    END IF;
    IF p_corrected_registered_on > public.berlin_today() THEN
      RAISE EXCEPTION 'registered_on_in_future';
    END IF;
    IF p_corrected_registered_on = g.registered_on THEN
      RAISE EXCEPTION 'correction_unchanged';
    END IF;
  END IF;
  INSERT INTO public.evidence_correction (id, project_id, participation_id, target_kind, action,
    document_id, asu_registration_id, ba_reporting_task_id, wrong_person,
    corrected_registered_on, reason, source, retention_class, requested_by)
  VALUES (v_id, r.project_id, r.id, p_target_kind, p_action,
    CASE WHEN p_target_kind::text = 'document' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'asu_registration' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'ba_reporting_task' THEN p_target_id END,
    p_wrong_person, p_corrected_registered_on, p_reason, v_source, v_class,
    (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_requested', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('correctionId', v_id,
      'targetKind', p_target_kind, 'action', p_action, 'reason', p_reason), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The decision (D29, D31): the regional operations manager of the project's region
-- (`actor_not_allowed` otherwise, also on behalf of a participant), never the requester
-- (`same_person_approval`), decides a pending request (`correction_not_pending` once decided:
-- the queue showed another state; `correction_not_found` for an unknown id) under the project's
-- exclusive lock. A rejection changes nothing but the request. An approval, at its own instant:
-- - a document: `invalidated_by_correction`; a wrong person's file also becomes a tombstone
--   (`wrong_person`, the file name erased) whose object the caller purges (the returned id);
-- - an ASU registration: `invalidated_by`, or `superseded_by` with a new current registration
--   carrying the corrected date, the same route and proof, recorded and proven now
--   (`correction_id`);
-- - a BA reporting task: a new `pending` replacement task (`replaces_task_id`, `correction_id`),
--   the original's `superseded_by`; the original's outcome and history stay.
-- A target corrected meanwhile is `target_corrected`. No status, guard, date or payment moves.
-- Audited `evidence_correction_decided`. Returns the document whose object is to be purged, or null.
CREATE FUNCTION decide_evidence_correction(
  p_context audit_context, p_correction_id uuid, p_approve boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.evidence_correction;
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_new uuid;
  v_purge uuid;
BEGIN
  IF p_correction_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project, participation and target never change, so they can be read before the lock.
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_not_found';
  END IF;
  PERFORM public.assert_context(p_context, c.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(c.project_id));
  SELECT * INTO r FROM public.participation WHERE id = c.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF c.target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document WHERE id = c.document_id FOR UPDATE;
  ELSIF c.target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration WHERE id = c.asu_registration_id FOR UPDATE;
  ELSE
    SELECT * INTO t FROM public.ba_reporting_task WHERE id = c.ba_reporting_task_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id FOR UPDATE;
  IF c.status::text <> 'requested' THEN
    RAISE EXCEPTION 'correction_not_pending';
  END IF;
  IF c.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF p_approve THEN
    IF c.target_kind::text = 'document' THEN
      IF d.deleted_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      UPDATE public.document SET invalidated_by_correction = c.id,
        deleted_at = CASE WHEN c.wrong_person THEN now() END,
        deleted_by = CASE WHEN c.wrong_person THEN 'user'::public.actor_type END,
        deleted_by_staff_user_id = CASE WHEN c.wrong_person THEN (p_context).staff_user_id END,
        delete_reason = CASE WHEN c.wrong_person THEN 'wrong_person'::public.document_delete_reason END,
        file_name = CASE WHEN c.wrong_person THEN NULL ELSE file_name END
      WHERE id = d.id;
      IF c.wrong_person THEN
        v_purge := d.id;
      END IF;
    ELSIF c.target_kind::text = 'asu_registration' THEN
      IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF c.action::text = 'invalidate' THEN
        UPDATE public.asu_registration SET invalidated_by = c.id WHERE id = g.id;
      ELSE
        UPDATE public.asu_registration SET superseded_by = c.id WHERE id = g.id;
        INSERT INTO public.asu_registration (id, project_id, participation_id, channel,
          registered_on, recorded_by, proof_kind, proof_document_id, attestation_source,
          proof_linked_by, proof_linked_at, correction_id)
        VALUES (pg_catalog.gen_random_uuid(), g.project_id, g.participation_id, g.channel,
          c.corrected_registered_on, (p_context).staff_user_id, g.proof_kind,
          g.proof_document_id, g.attestation_source, g.proof_linked_by,
          CASE WHEN g.proof_kind IS NOT NULL THEN now() END, c.id);
      END IF;
    ELSE
      IF t.superseded_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind,
        subject_date, amendment_id, replaces_task_id, correction_id)
      VALUES (t.participation_id, t.project_id, t.reporting_kind, t.subject_date, t.amendment_id,
        t.id, c.id)
      RETURNING id INTO v_new;
      UPDATE public.ba_reporting_task SET superseded_by = v_new WHERE id = t.id;
    END IF;
  END IF;
  UPDATE public.evidence_correction SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.correction_status,
    decided_by = (p_context).staff_user_id, decided_at = now()
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_decided', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('correctionId', c.id,
      'targetKind', c.target_kind, 'action', c.action, 'reason', c.reason,
      'decision', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END), false);
  RETURN v_purge;
END $$;
--> statement-breakpoint

-- Grants: transfer_app selects the corrections (the views and "Freigaben"; never written directly)
-- and executes the two writes; the helpers stay internal.
GRANT SELECT ON TABLE evidence_correction TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION evidence_correction_append_only, normalise_correction_source,
  request_evidence_correction, decide_evidence_correction FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION request_evidence_correction, decide_evidence_correction TO transfer_app;
