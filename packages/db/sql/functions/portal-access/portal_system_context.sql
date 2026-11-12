CREATE OR REPLACE FUNCTION public.portal_system_context(p_request_id text)
 RETURNS public.audit_context
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ROW('system', NULL, NULL, 'portal-activation', NULL, p_request_id, NULL)::public.audit_context
$function$;

ALTER FUNCTION public.portal_system_context(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.portal_system_context(text) FROM PUBLIC;
