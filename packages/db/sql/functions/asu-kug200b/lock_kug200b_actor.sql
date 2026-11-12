CREATE OR REPLACE FUNCTION public.lock_kug200b_actor(p_participation_id uuid, p_context public.audit_context, p_open boolean)
 RETURNS public.participation
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id)
     && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  IF p_open AND r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  RETURN r;
END $function$;

ALTER FUNCTION public.lock_kug200b_actor(uuid,public.audit_context,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_kug200b_actor(uuid,public.audit_context,boolean) FROM PUBLIC;
