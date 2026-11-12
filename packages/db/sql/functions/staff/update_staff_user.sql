CREATE OR REPLACE FUNCTION public.update_staff_user(p_id uuid, p_actor uuid, p_request_id text, p_display_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_may_create_projects boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  u public.staff_user;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_display_name IS NOT NULL AND NOT public.staff_text_valid(p_display_name)
     OR p_email IS NOT NULL AND NOT public.staff_email_valid(p_email) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_display_name IS NOT NULL AND p_display_name <> u.display_name THEN
    v_fields := pg_catalog.array_append(v_fields, 'displayName');
  END IF;
  IF p_email IS NOT NULL AND p_email <> u.email THEN
    v_fields := pg_catalog.array_append(v_fields, 'email');
  END IF;
  IF p_may_create_projects IS NOT NULL AND p_may_create_projects <> u.may_create_projects THEN
    v_fields := pg_catalog.array_append(v_fields, 'mayCreateProjects');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'staff_user_unchanged';
  END IF;
  BEGIN
    UPDATE public.staff_user
    SET display_name = coalesce(p_display_name, display_name), email = coalesce(p_email, email),
        may_create_projects = coalesce(p_may_create_projects, may_create_projects)
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'email_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_changed', p_actor, p_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'mayCreateProjects', CASE WHEN 'mayCreateProjects' = ANY (v_fields) THEN p_may_create_projects END)),
    p_request_id);
END $function$;

ALTER FUNCTION public.update_staff_user(uuid,uuid,text,text,text,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.update_staff_user(uuid,uuid,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_staff_user(uuid,uuid,text,text,text,boolean) TO transfer_app;
