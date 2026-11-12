CREATE OR REPLACE FUNCTION public.record_privacy_notice(p_participation_id uuid, p_language public.notice_language, p_method public.notice_method, p_notice_version text, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
END $function$;

ALTER FUNCTION public.record_privacy_notice(uuid,public.notice_language,public.notice_method,text,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_privacy_notice(uuid,public.notice_language,public.notice_method,text,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_privacy_notice(uuid,public.notice_language,public.notice_method,text,public.audit_context) TO transfer_app;
