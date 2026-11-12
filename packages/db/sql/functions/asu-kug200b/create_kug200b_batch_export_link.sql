CREATE OR REPLACE FUNCTION public.create_kug200b_batch_export_link(p_context public.audit_context, p_kind public.export_kind, p_batch_id uuid, p_session_hash text, p_link_hash text, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[])
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
  v_rows jsonb;
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_kind IS NULL
     OR p_kind::text NOT IN ('kug200b_batch_index', 'kug200b_batch_artifact', 'kug200b_batch_scans')
     OR p_batch_id IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_artifact IS NULL OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id
  WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
    AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_invalid';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  IF p_kind::text = 'kug200b_batch_scans' AND b.channel NOT IN ('scan_email', 'upload') THEN
    RAISE EXCEPTION 'export_not_applicable';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'batch_stale' USING DETAIL = v_rows::text;
  END IF;
  INSERT INTO public.export_link (token_hash, project_id, kind, document_ids, batch_id,
    staff_user_id, session_hash, expires_at)
  VALUES (p_link_hash, b.project_id, p_kind, '{}', b.id, (p_context).staff_user_id,
    p_session_hash, v_expires);
  PERFORM public.write_audit_event(b.project_id, NULL, 'export_created', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', p_kind,
      'count', b.member_count), false);
  RETURN v_expires;
END $function$;

ALTER FUNCTION public.create_kug200b_batch_export_link(public.audit_context,public.export_kind,uuid,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_kug200b_batch_export_link(public.audit_context,public.export_kind,uuid,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_kug200b_batch_export_link(public.audit_context,public.export_kind,uuid,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) TO transfer_app;
