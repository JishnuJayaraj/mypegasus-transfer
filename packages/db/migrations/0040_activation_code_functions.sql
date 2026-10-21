-- Hand-written (Slice 3, PR 3d; D12–D20, D26). Activation and Art. 14 evidence writes are
-- SECURITY DEFINER, use database time, keep codes/addresses/hashes out of audit, and are callable
-- only by transfer_app. Every issuance decision is repeated under the participation row lock.

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
    'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided'));
--> statement-breakpoint

CREATE FUNCTION assert_activation_actor(p_project_id uuid, p_context audit_context)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role IN ('project_lead', 'back_office') AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION issue_activation_code(
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

CREATE FUNCTION record_activation_delivery(
  p_activation_code_id uuid, p_outcome activation_delivery_status, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.activation_code;
  v_notice_id uuid;
  -- A reissue or terminal transition may have revoked the code during the send; that revocation
  -- and its reason stand.
  v_revoke boolean;
BEGIN
  SELECT * INTO c FROM public.activation_code WHERE id = p_activation_code_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation_code_not_found'; END IF;
  PERFORM public.assert_activation_actor(c.project_id, p_context);
  IF c.channel <> 'in_person' OR c.delivery_status <> 'pending'
     OR p_outcome NOT IN ('sent', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid_delivery_state';
  END IF;
  v_revoke := p_outcome = 'failed' AND c.revoked_at IS NULL AND c.locked_at IS NULL
    AND c.used_at IS NULL;
  UPDATE public.activation_code SET delivery_status = p_outcome,
    revoked_at = CASE WHEN v_revoke THEN now() ELSE revoked_at END,
    revoked_by = CASE WHEN v_revoke THEN (p_context).staff_user_id ELSE revoked_by END,
    revoke_reason = CASE WHEN v_revoke THEN 'delivery_failed' ELSE revoke_reason END
  WHERE id = c.id;
  PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_delivery',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
      'activationCodeId', c.id, 'outcome', CASE WHEN p_outcome = 'unknown'
        THEN 'delivery_unknown' ELSE p_outcome::text END), false);
  IF v_revoke THEN
    PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_revoked',
      p_context, NULL, NULL, NULL, 'delivery_failed', NULL,
      pg_catalog.jsonb_build_object('activationCodeId', c.id), false);
  ELSIF p_outcome = 'sent' THEN
    INSERT INTO public.privacy_notice_delivery (
      project_id, participation_id, notice_version, language, method, activation_code_id, provided_by)
    VALUES (c.project_id, c.participation_id, 'art14-activation:v1', c.notice_language,
      CASE WHEN c.delivery_kind = 'email' THEN 'email'::public.notice_method
           ELSE 'sms'::public.notice_method END,
      c.id, (p_context).staff_user_id) RETURNING id INTO v_notice_id;
    PERFORM public.write_audit_event(c.project_id, c.participation_id, 'privacy_notice_provided',
      p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
        'noticeDeliveryId', v_notice_id, 'activationCodeId', c.id,
        'noticeVersion', 'art14-activation:v1', 'language', c.notice_language,
        'method', CASE WHEN c.delivery_kind = 'email' THEN 'email' ELSE 'sms' END), false);
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION hand_over_activation_code(
  p_activation_code_id uuid, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.activation_code; v_notice_id uuid;
BEGIN
  SELECT * INTO c FROM public.activation_code WHERE id = p_activation_code_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation_code_not_found'; END IF;
  PERFORM public.assert_activation_actor(c.project_id, p_context);
  IF c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL OR c.revoked_at IS NOT NULL
     OR c.locked_at IS NOT NULL OR c.used_at IS NOT NULL OR c.expires_at <= now() THEN
    RAISE EXCEPTION 'handover_not_allowed';
  END IF;
  UPDATE public.activation_code SET identity_check = 'photo_id',
    identity_checked_by = (p_context).staff_user_id, identity_checked_at = now(),
    handed_over_by = (p_context).staff_user_id, handed_over_at = now() WHERE id = c.id;
  PERFORM public.write_audit_event(c.project_id, c.participation_id,
    'activation_code_handed_over', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('activationCodeId', c.id, 'method', 'official_photo_id'), false);
  INSERT INTO public.privacy_notice_delivery (
    project_id, participation_id, notice_version, language, method, activation_code_id, provided_by)
  VALUES (c.project_id, c.participation_id, 'art14-activation:v1', c.notice_language, 'sheet',
    c.id, (p_context).staff_user_id) RETURNING id INTO v_notice_id;
  PERFORM public.write_audit_event(c.project_id, c.participation_id,
    'privacy_notice_provided', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('noticeDeliveryId', v_notice_id, 'activationCodeId', c.id,
      'noticeVersion', 'art14-activation:v1', 'language', c.notice_language, 'method', 'sheet'), false);
END $$;
--> statement-breakpoint

CREATE FUNCTION revoke_activation_code(
  p_activation_code_id uuid, p_reason activation_revoke_reason, p_context audit_context
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.activation_code;
BEGIN
  SELECT * INTO c FROM public.activation_code WHERE id = p_activation_code_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation_code_not_found'; END IF;
  PERFORM public.assert_activation_actor(c.project_id, p_context);
  IF p_reason NOT IN ('not_handed_over', 'lost') THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF c.revoked_at IS NOT NULL OR c.locked_at IS NOT NULL OR c.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'activation_code_not_open';
  END IF;
  IF p_reason = 'not_handed_over' AND (c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL) THEN
    RAISE EXCEPTION 'handover_not_allowed';
  END IF;
  UPDATE public.activation_code SET revoked_by = (p_context).staff_user_id,
    revoked_at = now(), revoke_reason = p_reason WHERE id = c.id;
  PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_revoked',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('activationCodeId', c.id), false);
END $$;
--> statement-breakpoint

CREATE FUNCTION record_privacy_notice(
  p_participation_id uuid, p_language notice_language, p_method notice_method,
  p_notice_version text, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.participation; v_id uuid;
BEGIN
  p := public.lock_participation(p_participation_id);
  PERFORM public.assert_activation_actor(p.project_id, p_context);
  IF p_notice_version <> 'art14-activation:v1' OR p_method NOT IN ('letter', 'in_person_print') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_method = 'letter' AND NOT EXISTS (
    SELECT FROM public.participant_details d
    WHERE d.participation_id = p.id AND d.address_street IS NOT NULL) THEN
    RAISE EXCEPTION 'address_required';
  END IF;
  INSERT INTO public.privacy_notice_delivery (
    project_id, participation_id, notice_version, language, method, provided_by)
  VALUES (p.project_id, p.id, p_notice_version, p_language, p_method, (p_context).staff_user_id)
  RETURNING id INTO v_id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'privacy_notice_provided', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
      'noticeDeliveryId', v_id, 'noticeVersion', p_notice_version,
      'language', p_language, 'method', p_method), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION keep_privacy_notice_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'privacy_notice_immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER privacy_notice_delivery_immutable BEFORE UPDATE OR DELETE ON privacy_notice_delivery
FOR EACH ROW EXECUTE FUNCTION keep_privacy_notice_immutable();
--> statement-breakpoint

CREATE FUNCTION revoke_codes_at_terminal_status()
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
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER participation_terminal_revoke_codes AFTER UPDATE OF status ON participation
FOR EACH ROW EXECUTE FUNCTION revoke_codes_at_terminal_status();
--> statement-breakpoint

-- These event types are written only by the functions above.
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
      'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided') THEN
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

REVOKE ALL ON FUNCTION assert_activation_actor, issue_activation_code,
  record_activation_delivery, hand_over_activation_code, revoke_activation_code,
  record_privacy_notice, keep_privacy_notice_immutable, revoke_codes_at_terminal_status FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION issue_activation_code, record_activation_delivery,
  hand_over_activation_code, revoke_activation_code, record_privacy_notice TO transfer_app;
--> statement-breakpoint
GRANT SELECT ON TABLE activation_code, privacy_notice_delivery TO transfer_app;
