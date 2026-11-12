CREATE OR REPLACE FUNCTION public.hand_over_activation_code(p_activation_code_id uuid, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.hand_over_activation_code(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.hand_over_activation_code(uuid,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hand_over_activation_code(uuid,public.audit_context) TO transfer_app;
