CREATE OR REPLACE FUNCTION public.export_link_batch(p_context public.audit_context, p_link_hash text, p_session_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL
     OR l.kind::text NOT IN ('kug200b_batch_artifact', 'kug200b_batch_scans') THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  RETURN l.batch_id;
END $function$;

ALTER FUNCTION public.export_link_batch(public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.export_link_batch(public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_link_batch(public.audit_context,text,text) TO transfer_app;
