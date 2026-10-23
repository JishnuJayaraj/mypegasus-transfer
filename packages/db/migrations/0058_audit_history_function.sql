-- Hand-written (ADR-0002, the audit history; data-protection.md, audit metadata; Q157, Q161): the
-- history's reference rows, `audit_history` and their grants. Same hardening as 0056: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. `audit_history_opened` (0057) is compared as text here, since this runs in
-- the same migration transaction.
--
-- `audit_history` is the authorization boundary: `transfer_app` still has no privilege on
-- `audit_event`, and the function returns only the final projection. The API localizes and
-- validates; it removes nothing.

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
    'audit_history_opened'));
--> statement-breakpoint

-- The domain's `auditProjection` (packages/domain/src/audit/history.ts): the stream (null:
-- project-level), whether the change and the reason are shown, the detail keys.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('participation_created', NULL, 'case', true, false, '{}'),
  ('status_changed', 'status', 'case', true, true, '{entryKind,secondaryReasons}'),
  ('status_changed', 'profiling_status', 'profiling', true, false, '{}'),
  ('status_changed', 'dsv_status', 'dsv', true, false, '{offerDeadline}'),
  ('entry_wave_assigned', NULL, 'case', false, false, '{waveId,previousWaveId}'),
  ('profiling_exception_requested', NULL, 'profiling', false, true, '{}'),
  ('profiling_exception_approved', NULL, 'profiling', false, false, '{}'),
  ('profiling_exception_rejected', NULL, 'profiling', false, false, '{}'),
  ('profiling_exception_revoked', NULL, 'profiling', false, false, '{}'),
  ('profiling_exception_superseded', NULL, 'profiling', false, true, '{}'),
  ('end_reason_corrected', NULL, 'case', true, false, '{secondaryReasons}'),
  ('sensitive_read', NULL, 'security', false, false, '{}'),
  ('sensitive_write', NULL, 'security', false, false, '{}'),
  ('break_glass_access', NULL, 'security', false, false, '{}'),
  ('document_opened', NULL, 'security', false, false, '{}'),
  ('warning_confirmed', NULL, 'case', false, true, '{}'),
  ('export_created', NULL, 'security', false, false, '{}'),
  ('config_override_changed', NULL, NULL, false, false, '{}'),
  ('review_recorded', NULL, 'review', false, false, '{}'),
  ('clarification_requested', NULL, 'review', false, false, '{}'),
  ('project_created', NULL, NULL, false, false, '{}'),
  ('project_changed', NULL, NULL, false, false, '{}'),
  ('entry_wave_created', NULL, NULL, false, false, '{}'),
  ('entry_wave_changed', NULL, NULL, false, false, '{}'),
  ('config_template_pinned', NULL, NULL, false, false, '{}'),
  ('rule_relaxation_requested', NULL, NULL, false, false, '{}'),
  ('rule_relaxation_approved', NULL, NULL, false, false, '{}'),
  ('rule_relaxation_rejected', NULL, NULL, false, false, '{}'),
  ('rule_relaxation_withdrawn', NULL, NULL, false, false, '{}'),
  ('project_activated', NULL, NULL, false, false, '{}'),
  ('participant_data_changed', NULL, 'case', false, false, '{fields}'),
  ('import_confirmed', NULL, NULL, false, false, '{}'),
  ('participation_created_manually', NULL, 'case', false, false, '{}'),
  ('participation_dates_changed', NULL, 'dsv', false, false, '{oldTgStart,newTgStart,oldTgEnd,newTgEnd,reportingKinds}'),
  ('project_member_added', NULL, NULL, false, false, '{}'),
  ('project_member_removed', NULL, NULL, false, false, '{}'),
  ('participant_assigned', NULL, 'case', false, false, '{}'),
  ('participant_unassigned', NULL, 'case', false, true, '{}'),
  ('activation_code_issued', NULL, 'case', false, false, '{purpose,channel,deliveryKind}'),
  ('activation_code_delivery', NULL, 'case', false, false, '{outcome}'),
  ('activation_code_handed_over', NULL, 'case', false, false, '{method}'),
  ('activation_code_revoked', NULL, 'case', false, true, '{}'),
  ('privacy_notice_provided', NULL, 'case', false, false, '{method}'),
  ('participant_activated', NULL, 'case', false, false, '{}'),
  ('consent_given', NULL, 'case', false, false, '{purpose,textVersion}'),
  ('contact_channel_added', NULL, 'case', false, false, '{kind}'),
  ('activation_code_locked', NULL, 'security', false, false, '{}'),
  ('one_time_code_exhausted', NULL, 'security', false, false, '{}'),
  ('participant_logout', NULL, 'security', false, false, '{}'),
  ('participant_login', NULL, 'security', false, false, '{}'),
  ('contact_channel_removed', NULL, 'case', false, true, '{kind}'),
  ('consent_ended', NULL, 'case', false, true, '{purpose}'),
  ('contact_channels_suspended', NULL, 'security', false, false, '{}'),
  ('placement_agentur_set', NULL, 'case', false, false, '{agenturKey,previousAgenturKey}'),
  ('self_service_notice_acknowledged', NULL, 'case', false, false, '{noticeVersion}'),
  ('step_up_completed', NULL, 'security', false, false, '{}'),
  ('step_up_failed', NULL, 'security', false, false, '{}'),
  ('assisted_mode_started', NULL, 'security', false, false, '{}'),
  ('assisted_mode_ended', NULL, 'security', false, false, '{}'),
  ('document_added', NULL, 'case', false, false, '{documentType,source}'),
  ('document_reviewed', NULL, 'case', false, true, '{documentType,decision}'),
  ('document_deleted', NULL, 'case', false, true, '{documentType}'),
  ('document_upload_rejected', NULL, 'security', false, false, '{}'),
  ('reminder_queued', NULL, 'case', false, false, '{kind,channelKind}'),
  ('reminder_delivery', NULL, 'case', false, true, '{outcome}'),
  ('audit_history_opened', NULL, 'security', false, false, '{}');
--> statement-breakpoint

-- The domain's `roleFieldKnowledge`: the categories whose field keys each project role may know.
INSERT INTO role_field_knowledge (project_role, access_category) VALUES
  ('project_lead', 'case_internal'), ('project_lead', 'confidential'), ('project_lead', 'health'),
  ('project_lead', 'disability'), ('project_lead', 'absence'), ('consultant', 'case_internal'),
  ('consultant', 'confidential'), ('consultant', 'health'), ('consultant', 'disability'),
  ('consultant', 'identifiers'), ('consultant', 'residence_social'), ('consultant',
  'profiling_assessment'), ('consultant', 'absence'), ('back_office', 'case_internal'),
  ('back_office', 'confidential'), ('back_office', 'disability'), ('back_office', 'identifiers'),
  ('back_office', 'residence_social'), ('back_office', 'absence');
--> statement-breakpoint

-- The field catalog's categories, and `custom.*` for every custom field.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('status', 'case_internal'), ('profilingStatus', 'case_internal'), ('dsvStatus',
  'case_internal'), ('activationStatus', 'case_internal'), ('privacyNoticeState',
  'case_internal'), ('offerDeadline', 'case_internal'), ('tgStart', 'case_internal'), ('tgEnd',
  'case_internal'), ('dsvSignedOn', 'case_internal'), ('tgEntryDate', 'case_internal'),
  ('exitDate', 'case_internal'), ('withdrawnOn', 'case_internal'), ('profilingDoneOn',
  'case_internal'), ('placementAgenturKey', 'case_internal'), ('firstName', 'confidential'),
  ('lastName', 'confidential'), ('personnelNumber', 'confidential'), ('birthDate',
  'confidential'), ('workEmail', 'confidential'), ('oldEmploymentEndDate', 'confidential'),
  ('knowledgeDate', 'confidential'), ('address', 'confidential'), ('phone', 'confidential'),
  ('mobile', 'confidential'), ('privateEmail', 'confidential'), ('reminderLog', 'case_internal'),
  ('portalChannels', 'confidential'), ('maritalStatus', 'confidential'), ('gender',
  'confidential'), ('educationHistory', 'confidential'), ('workHistory', 'confidential'),
  ('languageSkills', 'confidential'), ('drivingLicence', 'confidential'), ('vehicleAvailable',
  'confidential'), ('workingTimePreferences', 'confidential'), ('jobWishes', 'confidential'),
  ('desiredWorkLocations', 'confidential'), ('maxCommuteDistance', 'confidential'),
  ('earliestStartDate', 'confidential'), ('qualifications', 'confidential'), ('profilingSessions',
  'confidential'), ('jobboerseChoice', 'confidential'), ('baContactConsent', 'confidential'),
  ('endReason', 'confidential'), ('dsvAmendment', 'confidential'), ('baReportingTask',
  'confidential'), ('profilingExceptionReasonCode', 'confidential'), ('healthRestrictions',
  'health'), ('severeDisability', 'disability'), ('disabilityDegree', 'disability'),
  ('pensionInsuranceNumber', 'identifiers'), ('taxId', 'identifiers'), ('iban', 'identifiers'),
  ('baCustomerNumber', 'identifiers'), ('nationality', 'residence_social'), ('entryToGermanyDate',
  'residence_social'), ('residenceStatus', 'residence_social'), ('buergergeld',
  'residence_social'), ('unemploymentPeriod', 'residence_social'), ('profilingAssessment',
  'profiling_assessment'), ('overallAssessment', 'profiling_assessment'), ('nextSteps',
  'profiling_assessment'), ('profilingHealthAssessment', 'profiling_assessment'),
  ('absencePeriods', 'absence'), ('custom.*', 'confidential');
--> statement-breakpoint

-- Internal helper (no grant).

-- The shown details of an event: the allowed keys only; in `fields` (the field keys of a
-- person-data change) only the keys of a category the viewer may know, in their order; a key left
-- without a known field is absent.
CREATE FUNCTION audit_history_details(p_details jsonb, p_keys text[], p_known access_category[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(d.key, d.value), '{}'::jsonb)
  FROM (
    SELECT e.key, CASE
        WHEN e.key <> 'fields' THEN e.value
        WHEN pg_catalog.jsonb_typeof(e.value) = 'array' THEN (
          SELECT pg_catalog.jsonb_agg(f.value ORDER BY f.position)
          FROM pg_catalog.jsonb_array_elements_text(e.value) WITH ORDINALITY AS f(value, position)
          JOIN public.field_access_category c ON c.field_key =
            CASE WHEN f.value LIKE 'custom.%' THEN 'custom.*' ELSE f.value END
          WHERE c.access_category = ANY (p_known))
      END AS value
    FROM pg_catalog.jsonb_each(p_details) AS e(key, value)
    WHERE e.key = ANY (p_keys)
  ) d
  WHERE d.value IS NOT NULL
$$;
--> statement-breakpoint

-- The function transfer_app may execute.

-- A participation's audit history (data-protection.md, audit metadata; Q157), newest first, at
-- most 100 rows before `p_before_seq` (the API's opaque cursor). The viewer is the staff user of
-- the live session (`unauthenticated`), a member of the participation's project (`not_member`),
-- with a role that has a history; a consultant only while assigned (`not_assigned`). Rows: the PL
-- `case`, `profiling`, `dsv`; the assigned consultant `case`, `profiling` and their own `dsv` and
-- `payroll` events; back office `dsv`, `payroll`; the union of the viewer's roles (Q61). Never a
-- `security` or `review` event, nor a project-level one. Of each row only what its type's
-- projection shows: `field`, `from`, `to` and the reason code are null otherwise, the details
-- hold only the allowed keys (`audit_history_details`). The actor: a staff member's current
-- display name while their account keeps it (Q161), the system's job, whether on behalf of the
-- participant (assisted mode). The first page (no `p_before_seq`) writes `audit_history_opened`.
CREATE FUNCTION audit_history(
  p_staff_session_hash text, p_participation_id uuid, p_before_seq bigint, p_limit integer,
  p_request_id text DEFAULT NULL
) RETURNS TABLE (seq bigint, occurred_at timestamptz, event_type audit_event_type,
  actor_type actor_type, actor_name text, system_job text, on_behalf boolean, field status_field,
  from_value text, to_value text, reason_code text, effective_date date, details jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_staff uuid;
  v_project uuid;
  v_roles text[];
  v_streams public.audit_stream[] := '{}';
  v_own public.audit_stream[] := '{}';
  v_known public.access_category[];
BEGIN
  IF p_participation_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_before_seq < 1 OR p_request_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT s.staff_user_id INTO v_staff
  FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id AND u.deactivated_at IS NULL
  WHERE s.token_hash = p_staff_session_hash AND s.ended_at IS NULL AND s.expires_at > now();
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  SELECT p.project_id INTO v_project FROM public.participation p WHERE p.id = p_participation_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_membership m
                 WHERE m.project_id = v_project AND m.staff_user_id = v_staff) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  -- The current memberships, the consultant only while assigned.
  v_roles := public.document_staff_roles(p_participation_id, v_staff);
  IF 'project_lead' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling,dsv}'::public.audit_stream[];
  END IF;
  IF 'consultant' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling}'::public.audit_stream[];
    v_own := '{dsv,payroll}';
  END IF;
  IF 'back_office' = ANY (v_roles) THEN
    v_streams := v_streams || '{dsv,payroll}'::public.audit_stream[];
  END IF;
  IF pg_catalog.cardinality(v_streams) = 0 THEN
    RAISE EXCEPTION 'not_assigned';
  END IF;
  v_known := ARRAY(SELECT DISTINCT k.access_category FROM public.role_field_knowledge k
                   WHERE k.project_role::text = ANY (v_roles));

  IF p_before_seq IS NULL THEN
    PERFORM public.write_audit_event(v_project, p_participation_id, 'audit_history_opened',
      ROW('user', v_staff, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb, false);
  END IF;

  RETURN QUERY
  SELECT e.seq, e.occurred_at, e.event_type, e.actor_type,
    CASE WHEN e.actor_type = 'user' THEN u.display_name END,
    e.system_job,
    e.on_behalf_of_participation_id IS NOT NULL,
    CASE WHEN pr.shows_change THEN e.field END,
    CASE WHEN pr.shows_change THEN e.from_value END,
    CASE WHEN pr.shows_change THEN e.to_value END,
    CASE WHEN pr.shows_reason THEN e.reason_code END,
    e.effective_date,
    public.audit_history_details(e.details, pr.detail_keys, v_known)
  FROM public.audit_event e
  JOIN public.audit_event_projection pr ON pr.event_type = e.event_type::text
    AND pr.field IS NOT DISTINCT FROM
      CASE WHEN e.event_type::text = 'status_changed' THEN e.field END
  LEFT JOIN public.staff_user u ON u.id = e.actor_staff_user_id
  WHERE e.participation_id = p_participation_id AND e.project_id = v_project
    AND (p_before_seq IS NULL OR e.seq < p_before_seq)
    AND (pr.stream = ANY (v_streams)
         OR pr.stream = ANY (v_own) AND e.actor_staff_user_id = v_staff)
  ORDER BY e.seq DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint

-- Replaced: the history's opening is written only by `audit_history`.
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
      'reminder_queued', 'reminder_delivery', 'audit_history_opened') THEN
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

-- Grants: the reference tables and the function; still no privilege on audit_event.
GRANT SELECT ON TABLE audit_event_projection, role_field_knowledge, field_access_category
  TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_history_details, audit_history FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_history TO transfer_app;
