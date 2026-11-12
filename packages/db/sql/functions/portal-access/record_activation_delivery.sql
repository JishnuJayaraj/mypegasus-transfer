CREATE OR REPLACE FUNCTION public.record_activation_delivery(p_activation_code_id uuid, p_outcome public.activation_delivery_status, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.record_activation_delivery(uuid,public.activation_delivery_status,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_activation_delivery(uuid,public.activation_delivery_status,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_activation_delivery(uuid,public.activation_delivery_status,public.audit_context) TO transfer_app;
