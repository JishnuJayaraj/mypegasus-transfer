CREATE OR REPLACE FUNCTION public.add_project_member(p_project_id uuid, p_staff_user_id uuid, p_role public.project_role, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := (p_context).staff_user_id;
  u public.staff_user;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_team_context(p_context);
  IF p_staff_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF NOT public.is_project_lead(p_project_id, v_actor) THEN
    IF p_role <> 'project_lead' THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    PERFORM public.assert_global_admin(v_actor);
    IF p_staff_user_id = v_actor THEN
      RAISE EXCEPTION 'own_account';
    END IF;
  END IF;
  -- Shared: a deactivation of the account (FOR UPDATE) never interleaves.
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  INSERT INTO public.project_membership (project_id, staff_user_id, role)
  VALUES (p_project_id, p_staff_user_id, p_role) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_exists';
  END IF;
  PERFORM public.write_audit_event(p_project_id, NULL, 'project_member_added', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('staffUserId', p_staff_user_id, 'role', p_role), false);
END $function$;

ALTER FUNCTION public.add_project_member(uuid,uuid,public.project_role,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.add_project_member(uuid,uuid,public.project_role,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_project_member(uuid,uuid,public.project_role,public.audit_context) TO transfer_app;
