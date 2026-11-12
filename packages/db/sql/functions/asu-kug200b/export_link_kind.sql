CREATE OR REPLACE FUNCTION public.export_link_kind(p_context public.audit_context, p_link_hash text, p_session_hash text)
 RETURNS public.export_kind
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN (public.live_export_link(p_context, p_link_hash, p_session_hash)).kind;
END $function$;

ALTER FUNCTION public.export_link_kind(public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.export_link_kind(public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_link_kind(public.audit_context,text,text) TO transfer_app;
