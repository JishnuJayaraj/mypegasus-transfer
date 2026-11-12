CREATE OR REPLACE FUNCTION public.lock_profiler(p_participation_id uuid, p_context public.audit_context)
 RETURNS public.participation
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation;
BEGIN
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF NOT 'consultant' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  RETURN r;
END $function$;

ALTER FUNCTION public.lock_profiler(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_profiler(uuid,public.audit_context) FROM PUBLIC;
