CREATE OR REPLACE FUNCTION public.issue_activation_code(p_participation_id uuid, p_code_hash text, p_channel public.activation_channel, p_language public.notice_language, p_notice_version text, p_replace_open_code boolean, p_delivery_kind public.activation_delivery_kind, p_delivery_address_hash text, p_identity_checked boolean, p_context public.audit_context, p_id uuid DEFAULT NULL::uuid, p_purpose public.activation_purpose DEFAULT 'activation'::public.activation_purpose)
 RETURNS public.activation_code
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.issue_activation_code(uuid,text,public.activation_channel,public.notice_language,text,boolean,public.activation_delivery_kind,text,boolean,public.audit_context,uuid,public.activation_purpose) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.issue_activation_code(uuid,text,public.activation_channel,public.notice_language,text,boolean,public.activation_delivery_kind,text,boolean,public.audit_context,uuid,public.activation_purpose) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_activation_code(uuid,text,public.activation_channel,public.notice_language,text,boolean,public.activation_delivery_kind,text,boolean,public.audit_context,uuid,public.activation_purpose) TO transfer_app;
