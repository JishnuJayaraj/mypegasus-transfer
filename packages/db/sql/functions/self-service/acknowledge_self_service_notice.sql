CREATE OR REPLACE FUNCTION public.acknowledge_self_service_notice(p_participation_id uuid, p_context public.audit_context, p_notice_version text, p_language public.notice_language, p_id uuid, p_token_hash text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; v_id uuid;
BEGIN
  IF p_notice_version IS NULL OR p_notice_version !~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'
     OR p_language IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_self_service_writer(p_participation_id, p_context, p_token_hash);
  INSERT INTO public.self_service_notice_acknowledgement (id, project_id, participation_id,
    notice_version, language, actor_type, actor_staff_user_id)
  VALUES (p_id, r.project_id, r.id, p_notice_version, p_language, (p_context).actor_type,
    (p_context).staff_user_id)
  ON CONFLICT (participation_id, notice_version) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'self_service_notice_acknowledged',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
      'acknowledgementId', v_id, 'noticeVersion', p_notice_version, 'language', p_language), false);
  RETURN true;
END $function$;

ALTER FUNCTION public.acknowledge_self_service_notice(uuid,public.audit_context,text,public.notice_language,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.acknowledge_self_service_notice(uuid,public.audit_context,text,public.notice_language,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_self_service_notice(uuid,public.audit_context,text,public.notice_language,uuid,text) TO transfer_app;
