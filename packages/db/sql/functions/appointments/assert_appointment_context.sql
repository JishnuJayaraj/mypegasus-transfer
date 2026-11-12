CREATE OR REPLACE FUNCTION public.assert_appointment_context(p_context public.audit_context, p_participation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
END $function$;

ALTER FUNCTION public.assert_appointment_context(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_appointment_context(public.audit_context,uuid) FROM PUBLIC;
