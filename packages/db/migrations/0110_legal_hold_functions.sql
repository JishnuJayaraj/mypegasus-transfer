-- Stage one per class, legal holds and the evidence-only phase (ADR-0008; data-protection.md,
-- retention per class, legal holds, the evidence-only phase). Hand-written.
--
-- The job decides what is due in the domain (`retentionDue`, `evidenceOnlyApplies`); these
-- functions read the facts it needs, delete one class of one participation (`personnel_file`,
-- `health_record`) skipping exactly the held rows, and start the evidence-only phase. They refuse
-- outside a run of the retention role, as 0108's do. The legal holds are placed by the PL or back
-- office and released by another regional operations manager of the region (Q218). From the
-- evidence-only phase one trigger on the participant tables refuses every write outside a run.

GRANT SELECT ON public.legal_hold TO transfer_app;
--> statement-breakpoint

-- Every write to a participation's rows in the evidence-only phase is refused outside a retention
-- run (data-protection.md, the evidence-only phase; Q64). One function on every participant table.
CREATE FUNCTION refuse_in_evidence_set_phase()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN pg_catalog.to_jsonb(OLD) ELSE pg_catalog.to_jsonb(NEW) END;
  v_id uuid;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'participation' THEN
    IF TG_OP <> 'INSERT' AND OLD.evidence_set_since IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_set_phase';
    END IF;
  ELSE
    v_id := (v_row ->> 'participation_id')::uuid;
    IF v_id IS NOT NULL AND EXISTS (SELECT FROM public.participation
        WHERE id = v_id AND evidence_set_since IS NOT NULL) THEN
      RAISE EXCEPTION 'evidence_set_phase';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables b ON b.table_name = c.table_name AND b.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'participation_id'
      AND b.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('audit_event', 'legal_hold')
    UNION SELECT 'participation'
  LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase()',
      t || '_evidence_set_phase', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The facts the job needs per participation that closed (withdrawn, ta_completed, exited): its
-- triggers' days, the funding, the held scope and which classes still hold data. Ids, codes and
-- days only.
CREATE FUNCTION retention_participations(p_run uuid)
RETURNS TABLE (participation_id uuid, status text, closed_on date, withdrawn_on date,
  exit_date date, entered_tg boolean, dsv_fully_executed boolean, funded110 text,
  evidence_set_since timestamptz, held_classes text[], held_record_kinds text[],
  held_documents integer, classes_left text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN QUERY
  SELECT p.id, p.status::text,
    (SELECT (max(e.occurred_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.audit_event e
     WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status'),
    p.withdrawn_on, p.exit_date, p.tg_entry_date IS NOT NULL,
    EXISTS (SELECT FROM public.dsv_contract c WHERE c.participation_id = p.id
      AND c.fully_executed_on IS NOT NULL),
    p.funded110::text, p.evidence_set_since,
    coalesce((SELECT array_agg(DISTINCT x) FROM public.legal_hold h, unnest(h.classes) x
      WHERE h.participation_id = p.id AND h.released_at IS NULL), '{}'),
    coalesce((SELECT array_agg(DISTINCT x) FROM public.legal_hold h, unnest(h.record_kinds) x
      WHERE h.participation_id = p.id AND h.released_at IS NULL), '{}'),
    coalesce((SELECT sum(cardinality(h.document_ids))::integer FROM public.legal_hold h
      WHERE h.participation_id = p.id AND h.released_at IS NULL), 0),
    public.retention_classes_left(p.id)
  FROM public.participation p
  WHERE p.status::text IN ('withdrawn', 'ta_completed', 'exited')
  ORDER BY p.id;
END $$;
--> statement-breakpoint

-- Which classes of a participation still hold data (stage one's classes and the evidence set's;
-- a document by its own class, a working copy only while its file is stored). Internal.
CREATE FUNCTION retention_classes_left(p_participation_id uuid)
RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(SELECT c FROM (VALUES
    ('participation_record', true),
    ('personnel_file',
      EXISTS (SELECT FROM public.participant_details WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profile WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_residence_social_data WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling_assessment WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.self_service_notice_acknowledgement WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.privacy_notice_delivery WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_account WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.consent_record WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_channel WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_reminder WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.appointment_booking WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.dsv_scan_signature WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.dsv_contract WHERE participation_id = p_participation_id
        AND original_location IS NOT NULL)
      OR EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
        AND retention_class = 'personnel_file' AND deleted_at IS NULL)),
    ('health_record',
      EXISTS (SELECT FROM public.participant_health_data WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling_health_assessment WHERE participation_id = p_participation_id)),
    ('form_working_copy', EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
      AND retention_class = 'form_working_copy' AND deleted_at IS NULL)),
    ('evidence_set', EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
      AND retention_class = 'evidence_set' AND deleted_at IS NULL))
  ) AS v(c, present) WHERE present);
$$;
--> statement-breakpoint

-- The documents of a class the job may purge: stored, not held. The job deletes their objects
-- first, then `retention_delete_class` records them (a retry is harmless).
CREATE FUNCTION retention_class_documents(p_run uuid, p_participation_id uuid, p_class text)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.retention_run_of(p_run);
  IF p_class IS DISTINCT FROM 'personnel_file' AND p_class IS DISTINCT FROM 'health_record' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  RETURN ARRAY(SELECT d.id FROM public.document d
    WHERE d.participation_id = p_participation_id AND d.retention_class = p_class
      AND d.deleted_at IS NULL
      AND NOT EXISTS (SELECT FROM public.legal_hold h WHERE h.participation_id = p_participation_id
        AND h.released_at IS NULL AND (d.id = ANY (h.document_ids) OR p_class = ANY (h.classes)))
    ORDER BY d.id);
END $$;
--> statement-breakpoint
-- Deletes one class of one closed participation (data-protection.md, retention per class): the
-- personnel file or the health record, never another class; every row of it except the held ones
-- (a held class keeps all; a held record kind keeps its table; a held document itself). A row
-- another kept row still references waits for it (a consent behind a Kug 200b withdrawal, a
-- channel or booking behind a held reminder). Documents become tombstones (deleted by `system`,
-- the file name erased); the job deleted their objects first. The DSV facts of `dsv_contract` stay
-- (data-protection.md, the retained DSV facts); only the original's location goes with the
-- personnel file. Audited `retention_applied` with counts. A dry run counts and rolls back.
CREATE FUNCTION retention_delete_class(p_run uuid, p_participation_id uuid, p_class text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  p public.participation;
  v_classes text[];
  v_kinds text[];
  v_docs uuid[];
  v_deleted integer := 0;
  v_kept integer := 0;
  n integer;
BEGIN
  IF p_class IS DISTINCT FROM 'personnel_file' AND p_class IS DISTINCT FROM 'health_record' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  p := public.lock_participation(p_participation_id);
  IF p.status::text NOT IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_not_closed';
  END IF;
  IF p.evidence_set_since IS NOT NULL THEN RAISE EXCEPTION 'evidence_set_phase'; END IF;
  SELECT coalesce(array_agg(DISTINCT c), '{}') INTO v_classes
  FROM public.legal_hold h, unnest(h.classes) c
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT k), '{}') INTO v_kinds
  FROM public.legal_hold h, unnest(h.record_kinds) k
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT d), '{}') INTO v_docs
  FROM public.legal_hold h, unnest(h.document_ids) d
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  IF p_class = ANY (v_classes) THEN
    RETURN pg_catalog.jsonb_build_object('deleted', 0, 'kept', 1, 'held', true);
  END IF;
  BEGIN
    IF p_class = 'health_record' THEN
      IF NOT 'participant_health_data' = ANY (v_kinds) THEN
        DELETE FROM public.participant_health_data WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling_health_assessment' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling_health_assessment WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
    ELSE
      IF NOT 'participant_reminder' = ANY (v_kinds) THEN
        DELETE FROM public.participant_reminder WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'appointment_booking' = ANY (v_kinds) THEN
        DELETE FROM public.appointment_booking b WHERE b.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.booking_id = b.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_channel' = ANY (v_kinds) THEN
        DELETE FROM public.participant_channel c WHERE c.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.channel_id = c.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'consent_record' = ANY (v_kinds) THEN
        DELETE FROM public.consent_record c WHERE c.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.consent_id = c.id)
          AND NOT EXISTS (SELECT FROM public.participant_channel m WHERE m.consent_id = c.id)
          AND NOT EXISTS (SELECT FROM public.kug200b_withdrawal w WHERE w.consent_id = c.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_details' = ANY (v_kinds) THEN
        DELETE FROM public.participant_details WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profile' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profile WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling_assessment' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling_assessment WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      DELETE FROM public.participant_residence_social_data WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.self_service_notice_acknowledgement WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.privacy_notice_delivery WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.participant_account WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      IF NOT 'dsv_scan_signature' = ANY (v_kinds) THEN
        DELETE FROM public.dsv_scan_signature s WHERE s.participation_id = p.id
          AND NOT s.document_id = ANY (v_docs);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'dsv_contract' = ANY (v_kinds) THEN
        UPDATE public.dsv_contract SET original_location = NULL
        WHERE participation_id = p.id AND original_location IS NOT NULL;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
    END IF;
    UPDATE public.document SET deleted_at = pg_catalog.now(), deleted_by = 'system',
      file_name = NULL, purged_at = pg_catalog.now()
    WHERE participation_id = p.id AND retention_class = p_class AND deleted_at IS NULL
      AND NOT id = ANY (v_docs);
    GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
    v_kept := pg_catalog.cardinality(v_kinds) + pg_catalog.cardinality(v_docs);
    PERFORM public.write_audit_event(p.project_id, p.id, 'retention_applied',
      ROW('system', NULL, NULL, 'retention', NULL, NULL, p_run::text)::public.audit_context,
      NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('retentionClass', p_class, 'deleted', v_deleted,
        'kept', v_kept), false);
    IF r.dry_run THEN RAISE EXCEPTION 'retention_dry_run'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'retention_dry_run' THEN RAISE; END IF;
  END;
  RETURN pg_catalog.jsonb_build_object('deleted', v_deleted, 'kept', v_kept, 'held', false);
END $$;
--> statement-breakpoint

-- Starts the evidence-only phase (data-protection.md, the evidence-only phase; Q64) when it
-- applies: the participation has an evidence set (it entered the TG, or its funding is
-- `known_yes`) and no class outside the evidence set holds data. From then the trigger refuses
-- every write outside a run and the API every ordinary read. False when it doesn't apply (yet).
CREATE FUNCTION retention_enter_evidence_only(p_run uuid, p_participation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  p public.participation;
BEGIN
  p := public.lock_participation(p_participation_id);
  IF p.status::text NOT IN ('withdrawn', 'ta_completed', 'exited') OR p.evidence_set_since IS NOT NULL
     OR NOT (p.tg_entry_date IS NOT NULL OR p.funded110::text = 'known_yes')
     OR NOT public.retention_classes_left(p.id) <@ '{participation_record,evidence_set}'::text[] THEN
    RETURN false;
  END IF;
  IF r.dry_run THEN RETURN true; END IF;
  UPDATE public.participation SET evidence_set_since = pg_catalog.now() WHERE id = p.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'retention_applied',
    ROW('system', NULL, NULL, 'retention', NULL, NULL, p_run::text)::public.audit_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('retentionClass', 'evidence_only', 'deleted', 0, 'kept', 0), false);
  RETURN true;
END $$;
--> statement-breakpoint

-- A legal hold (data-protection.md, legal holds; Q218): the PL or back office of the project, on
-- selected classes, record kinds or documents of this participation, never all of it
-- (`hold_scope_empty`, `hold_scope_too_broad`), with a reason code and the documented basis,
-- against the active holds read (`stale_holds`). Audited by the scope and the code, never the
-- basis.
CREATE FUNCTION place_legal_hold(p_context audit_context, p_participation_id uuid,
  p_classes text[], p_record_kinds text[], p_document_ids uuid[], p_reason text, p_basis text,
  p_expected_active uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.participation;
  v_id uuid;
  v_active uuid[];
BEGIN
  IF p_classes IS NULL OR p_record_kinds IS NULL OR p_document_ids IS NULL
     OR p_expected_active IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('litigation', 'authority_request', 'documented_dispute', 'dpo_instruction')
     OR p_basis IS NULL OR pg_catalog.char_length(p_basis) NOT BETWEEN 1 AND 200
     OR p_basis <> pg_catalog.btrim(p_basis) OR p_basis ~ '[[:cntrl:]]'
     OR NOT p_classes <@ '{personnel_file,health_record,form_working_copy,evidence_set}'::text[]
     OR NOT p_record_kinds <@ '{dsv_offer,dsv_contract,dsv_scan_signature,participant_reminder,appointment_booking,consent_record,participant_channel,participant_details,participant_profile,participant_profiling,participant_profiling_assessment,participant_health_data,participant_profiling_health_assessment}'::text[] THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  p := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(p.id, (p_context).staff_user_id)
     && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.document WHERE id = ANY (p_document_ids) ORDER BY id FOR SHARE;
  IF (SELECT count(*) FROM public.document WHERE id = ANY (p_document_ids)
      AND participation_id = p.id) <> pg_catalog.cardinality(ARRAY(SELECT DISTINCT unnest(p_document_ids))) THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_active FROM (
    SELECT id FROM public.legal_hold WHERE participation_id = p.id AND released_at IS NULL
    ORDER BY id FOR UPDATE) h;
  IF v_active IS DISTINCT FROM ARRAY(SELECT DISTINCT unnest(p_expected_active) ORDER BY 1) THEN
    RAISE EXCEPTION 'stale_holds';
  END IF;
  IF pg_catalog.cardinality(p_classes) + pg_catalog.cardinality(p_record_kinds)
     + pg_catalog.cardinality(p_document_ids) = 0 THEN
    RAISE EXCEPTION 'hold_scope_empty';
  END IF;
  IF p_classes @> '{personnel_file,health_record,form_working_copy,evidence_set}'::text[] THEN
    RAISE EXCEPTION 'hold_scope_too_broad';
  END IF;
  INSERT INTO public.legal_hold (project_id, participation_id, classes, record_kinds, document_ids,
    reason, basis, placed_by)
  VALUES (p.project_id, p.id, ARRAY(SELECT DISTINCT unnest(p_classes) ORDER BY 1),
    ARRAY(SELECT DISTINCT unnest(p_record_kinds) ORDER BY 1),
    ARRAY(SELECT DISTINCT unnest(p_document_ids) ORDER BY 1), p_reason, p_basis,
    (p_context).staff_user_id)
  RETURNING id INTO v_id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'legal_hold_placed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('holdId', v_id, 'reason', p_reason,
      'classes', (SELECT classes FROM public.legal_hold WHERE id = v_id),
      'recordKinds', (SELECT record_kinds FROM public.legal_hold WHERE id = v_id),
      'documentCount', (SELECT pg_catalog.cardinality(document_ids) FROM public.legal_hold WHERE id = v_id)),
    false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Releases a hold (Q218): a regional operations manager of the project's region who didn't place
-- it (`four_eyes`), against a documented legal or DPO instruction; once (`hold_released`).
CREATE FUNCTION release_legal_hold(p_context audit_context, p_hold_id uuid, p_source text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h public.legal_hold;
  p public.participation;
BEGIN
  IF p_hold_id IS NULL OR p_source IS NULL OR pg_catalog.char_length(p_source) NOT BETWEEN 1 AND 200
     OR p_source <> pg_catalog.btrim(p_source) OR p_source ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its participation never changes, so it can be read before the locks.
  SELECT * INTO h FROM public.legal_hold WHERE id = p_hold_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold_not_found'; END IF;
  PERFORM public.assert_context(p_context, h.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  p := public.lock_participation(h.participation_id);
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project j ON j.id = p.project_id AND j.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO h FROM public.legal_hold WHERE id = p_hold_id FOR UPDATE;
  IF h.placed_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'four_eyes'; END IF;
  IF h.released_at IS NOT NULL THEN RAISE EXCEPTION 'hold_released'; END IF;
  UPDATE public.legal_hold SET released_at = pg_catalog.now(),
    released_by = (p_context).staff_user_id, release_source = p_source
  WHERE id = h.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'legal_hold_released', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('holdId', h.id), false);
  RETURN h.id;
END $$;
--> statement-breakpoint
-- The three new audit types (compared as text: added in 0109).
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
    'reconciliation_replied', 'funding_status_set', 'legal_hold_placed', 'legal_hold_released',
    'retention_applied'));
--> statement-breakpoint
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('legal_hold_placed', NULL, 'security', false, false, '{}'),
  ('legal_hold_released', NULL, 'security', false, false, '{}'),
  ('retention_applied', NULL, 'security', false, false, '{}');
--> statement-breakpoint
-- As 0108 wrote it plus the holds and the retention job (written only by their functions).
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
      'funding_status_set', 'legal_hold_placed', 'legal_hold_released', 'retention_applied') THEN
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

REVOKE ALL ON FUNCTION refuse_in_evidence_set_phase, retention_participations,
  retention_classes_left, retention_class_documents, retention_delete_class,
  retention_enter_evidence_only, place_legal_hold, release_legal_hold FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retention_participations, retention_class_documents,
  retention_delete_class, retention_enter_evidence_only TO transfer_retention;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION place_legal_hold, release_legal_hold TO transfer_app;
