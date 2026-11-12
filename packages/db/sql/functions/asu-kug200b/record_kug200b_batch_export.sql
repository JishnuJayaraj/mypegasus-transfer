CREATE OR REPLACE FUNCTION public.record_kug200b_batch_export(p_context public.audit_context, p_link_hash text, p_session_hash text, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[], p_organisation_sha256 text, p_fingerprint text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
  l public.export_link;
BEGIN
  IF p_organisation_sha256 IS NULL OR p_organisation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_official_export(p_context, p_link_hash, p_session_hash, p_channel,
    p_artifact, p_outdated_versions);
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF public.kug200b_batch_export_fingerprint(b, l.kind::text, p_organisation_sha256)
     <> p_fingerprint THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  PERFORM public.write_audit_event(b.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', b.member_count), false);
END $function$;

ALTER FUNCTION public.record_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_kug200b_batch_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[],text,text) TO transfer_app;
