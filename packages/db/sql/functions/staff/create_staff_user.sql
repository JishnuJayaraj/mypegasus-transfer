CREATE OR REPLACE FUNCTION public.create_staff_user(p_display_name text, p_email text, p_may_create_projects boolean, p_actor uuid, p_request_id text, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF NOT public.staff_text_valid(p_display_name) OR NOT public.staff_email_valid(p_email)
     OR p_may_create_projects IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  BEGIN
    INSERT INTO public.staff_user (id, display_name, email, may_create_projects)
    VALUES (v_id, p_display_name, p_email, p_may_create_projects);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'email_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_account_created', p_actor, v_id,
    pg_catalog.jsonb_build_object('mayCreateProjects', p_may_create_projects), p_request_id);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.create_staff_user(text,text,boolean,uuid,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_staff_user(text,text,boolean,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_staff_user(text,text,boolean,uuid,text,uuid) TO transfer_app;
