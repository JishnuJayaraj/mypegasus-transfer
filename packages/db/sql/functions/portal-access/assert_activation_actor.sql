CREATE OR REPLACE FUNCTION public.assert_activation_actor(p_project_id uuid, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role IN ('project_lead', 'back_office') AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
END $function$;

ALTER FUNCTION public.assert_activation_actor(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_activation_actor(uuid,public.audit_context) FROM PUBLIC;
