CREATE OR REPLACE FUNCTION public.lock_kug200b_official_export(p_context public.audit_context, p_link_hash text, p_session_hash text, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[])
 RETURNS public.kug200b_batch
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
  b public.kug200b_batch;
  v_rows jsonb;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL
     OR l.kind::text NOT IN ('kug200b_batch_artifact', 'kug200b_batch_scans') THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  IF p_artifact IS NULL OR p_outdated_versions IS NULL
     OR pg_catalog.array_position(p_outdated_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(l.project_id));
  SELECT * INTO b FROM public.kug200b_batch WHERE id = l.batch_id;
  IF NOT public.kug200b_batch_lead(b.project_id, l.staff_user_id) OR b.status <> 'open' THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  v_rows := public.kug200b_batch_recheck(b, p_channel, p_artifact, p_outdated_versions);
  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    RAISE EXCEPTION 'export_stale' USING DETAIL = v_rows::text;
  END IF;
  RETURN b;
END $function$;

ALTER FUNCTION public.lock_kug200b_official_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_kug200b_official_export(public.audit_context,text,text,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) FROM PUBLIC;
