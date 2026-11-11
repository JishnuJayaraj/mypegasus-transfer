-- Retention's framework (ADR-0008; ADR-0002, the retention role; data-protection.md, retention
-- and deletion). Hand-written.
--
-- `transfer_retention` (created by `db:setup`; on the cluster with the same name) has no table
-- privilege and EXECUTE only on the `retention_*` functions below; `transfer_app` has none of them,
-- and `transfer_retention` none of the ordinary functions. Each `retention_*` function refuses
-- unless `session_user` is `transfer_retention` (`retention_role_required`). The immutability
-- triggers let a delete or an update through only inside a retention run: `session_user`
-- `transfer_retention` and the transaction-local `transfer.retention_run` naming an open run this
-- same transaction opened (`in_retention_run`); the setting alone or the role alone changes nothing.
-- What the job applies is decided in the domain (`retentionDue`, `retentionActivation`); a dry run
-- counts inside a savepoint it rolls back.
--
-- Back office records the settlement dates and the funding (data-protection.md, funding and
-- settlement dates; Q52, Q217) against the values read, audited `settlement_dates_set` and
-- `funding_status_set`.


-- Whether this transaction is inside a retention run (the trigger path). Not granted: it runs as the
-- functions' owner, since every write a trigger guards happens inside a SECURITY DEFINER function.
CREATE FUNCTION in_retention_run()
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v text := pg_catalog.current_setting('transfer.retention_run', true);
BEGIN
  IF session_user <> 'transfer_retention' OR v IS NULL
     OR v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT FROM public.retention_run WHERE id = v::uuid AND closed_at IS NULL
    AND opened_txid = pg_catalog.txid_current());
END $$;
--> statement-breakpoint

-- The run this transaction opened, or `run_not_open`; the role first.
CREATE FUNCTION retention_run_of(p_run uuid)
RETURNS retention_run LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.retention_run;
BEGIN
  IF session_user <> 'transfer_retention' THEN RAISE EXCEPTION 'retention_role_required'; END IF;
  IF NOT public.in_retention_run()
     OR pg_catalog.current_setting('transfer.retention_run', true) <> p_run::text THEN
    RAISE EXCEPTION 'run_not_open';
  END IF;
  SELECT * INTO r FROM public.retention_run WHERE id = p_run;
  RETURN r;
END $$;
--> statement-breakpoint

-- Opens a run for the Berlin day the job's clock gave; database time decides: a day after the
-- database's own is `run_not_due`. One run at a time; one per transaction.
CREATE FUNCTION retention_open_run(p_run_day date, p_dry_run boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF session_user <> 'transfer_retention' THEN RAISE EXCEPTION 'retention_role_required'; END IF;
  IF p_run_day IS NULL OR p_dry_run IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF p_run_day > (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date THEN
    RAISE EXCEPTION 'run_not_due';
  END IF;
  IF coalesce(pg_catalog.current_setting('transfer.retention_run', true), '') <> '' THEN
    RAISE EXCEPTION 'run_open';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('retention_run'));
  INSERT INTO public.retention_run (id, run_day, dry_run, opened_txid)
  VALUES (v_id, p_run_day, p_dry_run, pg_catalog.txid_current());
  PERFORM pg_catalog.set_config('transfer.retention_run', v_id::text, true);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Closes the run with its summary (counts per class and outcome; never a subject).
CREATE FUNCTION retention_close_run(p_run uuid, p_summary jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.retention_run_of(p_run);
  IF pg_catalog.jsonb_typeof(p_summary) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  UPDATE public.retention_run SET closed_at = pg_catalog.now(), summary = p_summary WHERE id = p_run;
  PERFORM pg_catalog.set_config('transfer.retention_run', '', true);
END $$;
--> statement-breakpoint

-- Access credentials (Q122): every session, code, challenge and link that ended (used, expired,
-- locked, revoked or ended; a participant session's last use) on or before `p_cutoff` (Berlin
-- days; the domain's `credentialCutoff`) is deleted, a secret never kept usable. A row another
-- remaining credential still references waits for it. Returns the counts per table; a dry run
-- counts the same deletions and rolls them back.
CREATE FUNCTION retention_purge_credentials(p_run uuid, p_cutoff date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  v jsonb := '{}';
  n integer;
BEGIN
  IF p_cutoff IS NULL OR p_cutoff >= r.run_day THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  BEGIN
    DELETE FROM public.document_link WHERE (expires_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('document_link', n);
    DELETE FROM public.export_link WHERE (expires_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('export_link', n);
    DELETE FROM public.assisted_mode WHERE (ended_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('assisted_mode', n);
    DELETE FROM public.participant_session
    WHERE (coalesce(ended_at, last_seen_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('participant_session', n);
    DELETE FROM public.one_time_code_challenge
    WHERE (coalesce(consumed_at, invalidated_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('one_time_code_challenge', n);
    DELETE FROM public.activation_code c
    WHERE (coalesce(used_at, locked_at, revoked_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff
      AND NOT EXISTS (SELECT FROM public.participant_session s WHERE s.activation_code_id = c.id);
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('activation_code', n);
    DELETE FROM public.staff_session s
    WHERE (coalesce(ended_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff
      AND NOT EXISTS (SELECT FROM public.assisted_mode a WHERE a.staff_session_hash = s.token_hash);
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('staff_session', n);
    IF r.dry_run THEN RAISE EXCEPTION 'retention_dry_run'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'retention_dry_run' THEN RAISE; END IF;
  END;
  RETURN v;
END $$;
--> statement-breakpoint

-- The generated working copies whose file is still stored (data-protection.md, generated forms;
-- Q179): ids and the Berlin days of their triggers only, for the domain's `retentionDue`.
CREATE FUNCTION retention_working_copies(p_run uuid)
RETURNS TABLE (document_id uuid, generated_on date, superseded_on date, scan_accepted_on date,
  closed_on date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN QUERY
  SELECT d.id,
    (g.generated_at AT TIME ZONE 'Europe/Berlin')::date,
    (SELECT (min(n.generated_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.form_generation n
     WHERE n.participation_id = g.participation_id AND n.form_code = g.form_code
       AND (n.generated_at, n.id) > (g.generated_at, g.id)),
    (SELECT (min(s.reviewed_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.document s
     WHERE s.generation_document_id = d.id AND s.review_state = 'accepted'),
    CASE WHEN p.status::text IN ('withdrawn', 'ta_completed', 'exited') THEN
      (SELECT (max(e.occurred_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.audit_event e
       WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status')
    END
  FROM public.document d
  JOIN public.form_generation g ON g.document_id = d.id
  JOIN public.participation p ON p.id = d.participation_id
  WHERE d.retention_class = 'form_working_copy' AND d.deleted_at IS NULL
  ORDER BY d.id;
END $$;
--> statement-breakpoint

-- Records a working copy's file as gone (the job deleted the object first, so a retry is
-- harmless): the row stays as the tombstone, deleted by `system`, its file name erased. False in
-- a dry run or when it is no longer a stored working copy.
CREATE FUNCTION retention_purge_working_copy(p_run uuid, p_document_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  v_participation uuid;
BEGIN
  IF r.dry_run THEN RETURN false; END IF;
  SELECT participation_id INTO v_participation FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.lock_participation(v_participation);
  UPDATE public.document SET deleted_at = pg_catalog.now(), deleted_by = 'system', file_name = NULL,
    purged_at = pg_catalog.now()
  WHERE id = p_document_id AND retention_class = 'form_working_copy' AND deleted_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- Which of the stored objects' document ids have a document row; the rest are orphans.
CREATE FUNCTION retention_known_objects(p_run uuid, p_document_ids uuid[])
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN ARRAY(SELECT id FROM public.document WHERE id = ANY (coalesce(p_document_ids, '{}')));
END $$;
--> statement-breakpoint

-- The immutability triggers gain the retention path (as their newest migrations wrote them).
CREATE OR REPLACE FUNCTION refuse_config_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append_only';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION keep_privacy_notice_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'privacy_notice_immutable';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION keep_notice_acknowledgement_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notice_acknowledgement_immutable';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION profiling_exception_evidence_record_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record_immutable';
END $$;
--> statement-breakpoint
-- As 0088 wrote it, with the retention path.
CREATE OR REPLACE FUNCTION ba_reporting_task_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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
-- As 0106 wrote it, with the retention path.
CREATE OR REPLACE FUNCTION evidence_correction_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD.status::text <> 'requested' OR NEW.status::text = 'requested'
     OR (NEW.id, NEW.project_id, NEW.participation_id, NEW.target_kind, NEW.action,
         NEW.document_id, NEW.asu_registration_id, NEW.ba_reporting_task_id, NEW.wrong_person,
         NEW.corrected_registered_on, NEW.field_key, NEW.dsv_offer_id, NEW.signature_paper,
         NEW.signature_kind, NEW.corrected_on, NEW.original_on, NEW.reason, NEW.source,
         NEW.retention_class, NEW.requested_by, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.project_id, OLD.participation_id, OLD.target_kind, OLD.action,
         OLD.document_id, OLD.asu_registration_id, OLD.ba_reporting_task_id, OLD.wrong_person,
         OLD.corrected_registered_on, OLD.field_key, OLD.dsv_offer_id, OLD.signature_paper,
         OLD.signature_kind, OLD.corrected_on, OLD.original_on, OLD.reason, OLD.source,
         OLD.retention_class, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'correction_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- As 0004 wrote it, with the retention path.
CREATE OR REPLACE FUNCTION profiling_exception_request_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_old_undecided boolean := OLD.decided_by IS NULL AND OLD.decided_on IS NULL AND OLD.decided_at IS NULL;
  v_new_undecided boolean := NEW.decided_by IS NULL AND NEW.decided_on IS NULL AND NEW.decided_at IS NULL;
  v_new_complete boolean := NEW.decided_by IS NOT NULL AND NEW.decided_on IS NOT NULL AND NEW.decided_at IS NOT NULL;
  v_allowed boolean;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.project_id, NEW.participation_id, NEW.reason_code, NEW.requested_by,
      NEW.requested_on, NEW.requested_at, NEW.evidence_record_id, NEW.evidence_fingerprint)
     IS DISTINCT FROM
     (OLD.id, OLD.project_id, OLD.participation_id, OLD.reason_code, OLD.requested_by,
      OLD.requested_on, OLD.requested_at, OLD.evidence_record_id, OLD.evidence_fingerprint) THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  v_allowed := CASE
    WHEN OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected') THEN v_old_undecided AND v_new_complete
    WHEN OLD.status = 'requested' AND NEW.status IN ('revoked', 'superseded') THEN v_old_undecided AND v_new_undecided
    WHEN OLD.status = 'approved' AND NEW.status = 'revoked' THEN
      (NEW.decided_by, NEW.decided_on, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_on, OLD.decided_at)
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- As 0020 wrote it, with the retention path.
CREATE OR REPLACE FUNCTION config_relaxation_request_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_old_undecided boolean := OLD.decided_by IS NULL AND OLD.decided_on IS NULL AND OLD.decided_at IS NULL;
  v_new_undecided boolean := NEW.decided_by IS NULL AND NEW.decided_on IS NULL AND NEW.decided_at IS NULL;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.project_id, NEW.rule_id, NEW.reason_code, NEW.requested_by, NEW.requested_on,
      NEW.requested_at) IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.rule_id, OLD.reason_code,
      OLD.requested_by, OLD.requested_on, OLD.requested_at)
     OR NOT coalesce(OLD.status = 'requested' AND v_old_undecided AND CASE NEW.status
       WHEN 'approved' THEN NOT v_new_undecided
       WHEN 'rejected' THEN NOT v_new_undecided
       WHEN 'withdrawn' THEN v_new_undecided
       ELSE false END, false) THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The audit trail is append-only for every role, the owner included (ADR-0002): only a retention
-- run may delete or pseudonymise an event.
CREATE FUNCTION audit_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();
--> statement-breakpoint
CREATE TRIGGER staff_audit_event_append_only BEFORE UPDATE OR DELETE ON public.staff_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();
--> statement-breakpoint

-- The project's settlement dates (data-protection.md, settlement dates; Q52): back office of the
-- project, against the values read (`stale_settlement_dates`), under the exclusive project lock.
-- A date may be cleared; nothing defaults one. Audited with the names of the dates set.
CREATE FUNCTION set_settlement_dates(
  p_context audit_context, p_project_id uuid, p_kug_final date, p_measure110 date,
  p_expected_kug_final date, p_expected_measure110 date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.project_membership m
      JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
      WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
        AND m.role = 'back_office') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_project_id;
  IF (r.kug_final_settlement_date, r.measure110_settlement_date)
     IS DISTINCT FROM (p_expected_kug_final, p_expected_measure110) THEN
    RAISE EXCEPTION 'stale_settlement_dates';
  END IF;
  IF p_kug_final IS DISTINCT FROM r.kug_final_settlement_date THEN
    v_fields := v_fields || 'kugFinalSettlementDate'::text;
  END IF;
  IF p_measure110 IS DISTINCT FROM r.measure110_settlement_date THEN
    v_fields := v_fields || 'measure110SettlementDate'::text;
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN RAISE EXCEPTION 'project_unchanged'; END IF;
  UPDATE public.project SET kug_final_settlement_date = p_kug_final,
    measure110_settlement_date = p_measure110
  WHERE id = p_project_id;
  RETURN public.write_audit_event(p_project_id, NULL, 'settlement_dates_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields)), false);
END $$;
--> statement-breakpoint

-- A participation's funding (data-protection.md, funding; Q217): back office of its project, with
-- the documented source, against the value and source read (`stale_funding`). Audited with the
-- code, never the source.
CREATE FUNCTION set_funding_status(
  p_context audit_context, p_participation_id uuid, p_funded110 funded110, p_source text,
  p_expected_funded110 funded110, p_expected_source text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (r.funded110, r.funded110_source) IS DISTINCT FROM (p_expected_funded110, p_expected_source) THEN
    RAISE EXCEPTION 'stale_funding';
  END IF;
  IF p_funded110 IS NULL OR p_source IS NULL OR pg_catalog.char_length(p_source) NOT BETWEEN 1 AND 200
     OR p_source <> pg_catalog.btrim(p_source) OR p_source ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_funded110, p_source) IS NOT DISTINCT FROM (r.funded110, r.funded110_source) THEN
    RAISE EXCEPTION 'funding_unchanged';
  END IF;
  UPDATE public.participation SET funded110 = p_funded110, funded110_source = p_source,
    funded110_set_by = (p_context).staff_user_id, funded110_set_at = pg_catalog.now()
  WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id, 'funding_status_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('funded110', p_funded110), false);
END $$;
--> statement-breakpoint

-- The two new audit types (compared as text: added in this run).
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
    'evidence_correction_requested', 'evidence_correction_decided', 'dsv_form_generated', 'dsv_original_recorded',
    'entry_clarification_recorded', 'entry_clarification_escalated',
    'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified', 'tg_entry_reconciled', 'reconciliation_reviewed',
    'reconciliation_replied', 'funding_status_set'));
--> statement-breakpoint
INSERT INTO field_access_category (field_key, access_category) VALUES ('funded110', 'case_internal');
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('settlement_dates_set', NULL, NULL, false, false, '{}'),
  ('funding_status_set', NULL, 'case', false, false, '{funded110}');
--> statement-breakpoint

-- As 0104 wrote it plus the two retention inputs (written only by their functions).
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
      'evidence_correction_decided', 'dsv_form_generated', 'dsv_template_pinned', 'dsv_original_recorded',
      'entry_clarification_recorded', 'entry_clarification_escalated',
      'entry_clarification_instructed', 'entry_clarification_requested', 'dsv_customer_notified', 'tg_entry_reconciled',
      'reconciliation_reviewed', 'reconciliation_replied', 'settlement_dates_set',
      'funding_status_set') THEN
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

REVOKE ALL ON FUNCTION in_retention_run, retention_run_of, retention_open_run, retention_close_run,
  retention_purge_credentials, retention_working_copies, retention_purge_working_copy,
  retention_known_objects, audit_append_only, set_settlement_dates, set_funding_status FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retention_open_run, retention_close_run, retention_purge_credentials,
  retention_working_copies, retention_purge_working_copy, retention_known_objects
  TO transfer_retention;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_settlement_dates, set_funding_status TO transfer_app;
