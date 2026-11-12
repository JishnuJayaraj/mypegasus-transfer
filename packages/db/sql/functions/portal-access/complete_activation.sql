CREATE OR REPLACE FUNCTION public.complete_activation(p_token_hash text, p_new_token_hash text, p_notice_version text, p_consent_version text, p_language public.notice_language, p_channel_id uuid, p_consent_id uuid, p_request_id text, p_one_time_code_hash text DEFAULT NULL::text, p_delivery_address text DEFAULT NULL::text, p_delivery_address_hash text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.complete_activation(text,text,text,text,public.notice_language,uuid,uuid,text,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.complete_activation(text,text,text,text,public.notice_language,uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_activation(text,text,text,text,public.notice_language,uuid,uuid,text,text,text,text) TO transfer_app;
