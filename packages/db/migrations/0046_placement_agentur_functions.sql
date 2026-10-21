-- Hand-written (Slice 4a, PR 4a-1; Q139; regional-variation.md, "Placement Agentur"): the
-- placement Agentur of a participation and its automatic pin. Same hardening as 0016 and 0040:
-- SECURITY DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified
-- names, no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a
-- stable code, never a value. The decision (which version to pin, whether the override stays
-- valid) is the API's (`planPlacementAgentur`, `validateProjectOverride`) under the same lock; this
-- function holds the integrity it rests on.

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
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended', 'placement_agentur_set'));
--> statement-breakpoint

-- Sets the placement Agentur (Q139): the PL or back office of the project, while the participation
-- isn't terminal, in a draft or an active project. Any key in the template key format; a template
-- version (`p_pin_*`, all set or none) is pinned through pin_agentur_template in the same
-- transaction, only for an Agentur the project hasn't pinned (another version of a pinned one is a
-- migration with review). Lock order: the project (exclusive, like every pin), then the
-- participation. The audit event names the new and the replaced key and the base-defaults version
-- the override was checked with (Q107); a pin has its own `config_template_pinned`. Returns the
-- event's id.
CREATE FUNCTION set_placement_agentur(
  p_participation_id uuid, p_agentur_key text, p_base_defaults_version integer,
  p_context audit_context, p_pin_version integer DEFAULT NULL, p_pin_content jsonb DEFAULT NULL,
  p_pin_sha256 text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project_id uuid;
  p public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_base_defaults_version < 1, true)
     OR pg_catalog.num_nulls(p_pin_version, p_pin_content, p_pin_sha256) NOT IN (0, 3) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project_id);
  p := public.lock_participation(p_participation_id);
  IF NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = v_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role IN ('project_lead', 'back_office') AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF p.placement_agentur_key = p_agentur_key THEN
    RAISE EXCEPTION 'placement_agentur_unchanged';
  END IF;
  IF p_pin_version IS NOT NULL THEN
    -- Checks the content and the hash against a stored version, as for every pin, and refuses an
    -- Agentur the project has pinned already (`template_already_pinned`, 0023).
    PERFORM public.pin_agentur_template(v_project_id, p_agentur_key, p_pin_version, p_pin_content,
      p_pin_sha256, p_base_defaults_version, p_context);
  END IF;
  UPDATE public.participation
  SET placement_agentur_key = p_agentur_key, placement_agentur_set_at = now()
  WHERE id = p_participation_id;
  RETURN public.write_audit_event(v_project_id, p_participation_id, 'placement_agentur_set', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'agenturKey', p_agentur_key, 'previousAgenturKey', p.placement_agentur_key,
      'baseDefaultsVersion', p_base_defaults_version)), false);
END $$;
--> statement-breakpoint

-- Replaced: `placement_agentur_set` is written only by its function too.
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
      'placement_agentur_set') THEN
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

REVOKE ALL ON FUNCTION set_placement_agentur FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_placement_agentur TO transfer_app;
