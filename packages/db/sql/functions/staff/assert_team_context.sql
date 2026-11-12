CREATE OR REPLACE FUNCTION public.assert_team_context(p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
END $function$;

ALTER FUNCTION public.assert_team_context(public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_team_context(public.audit_context) FROM PUBLIC;
