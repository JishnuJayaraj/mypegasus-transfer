CREATE OR REPLACE FUNCTION public.lock_kug200b_batch_project(p_context public.audit_context, p_project_id uuid, p_hidden text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF p_hidden = 'batch_not_found'
     AND NOT public.kug200b_batch_lead(p_project_id, (p_context).staff_user_id)
     OR NOT EXISTS (
       SELECT FROM public.project_membership m
       JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
       WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id) THEN
    RAISE EXCEPTION '%', p_hidden;
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT public.kug200b_batch_lead(p_project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
END $function$;

ALTER FUNCTION public.lock_kug200b_batch_project(public.audit_context,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_kug200b_batch_project(public.audit_context,uuid,text) FROM PUBLIC;
