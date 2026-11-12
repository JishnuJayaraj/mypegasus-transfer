CREATE OR REPLACE FUNCTION public.create_project(p_name text, p_customer_name text, p_type public.project_type, p_context public.audit_context, p_id uuid DEFAULT NULL::uuid, p_region_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_staff uuid := (p_context).staff_user_id;
BEGIN
  -- The new project's exclusive lock first, like every setup mutation (D3, round 23).
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_id));
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.staff_user
      WHERE id = v_staff AND may_create_projects AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p_type IS NULL OR NOT public.project_text_valid(p_name) OR NOT public.project_text_valid(p_customer_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_region_id IS NULL THEN
    RAISE EXCEPTION 'region_required';
  END IF;
  IF NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  INSERT INTO public.project (id, name, customer_name, type, created_by, region_id)
  VALUES (v_id, p_name, p_customer_name, p_type, v_staff, p_region_id);
  INSERT INTO public.project_membership (project_id, staff_user_id, role)
  VALUES (v_id, v_staff, 'project_lead');
  PERFORM public.write_audit_event(v_id, NULL, 'project_created', p_context, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('type', p_type), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.create_project(text,text,public.project_type,public.audit_context,uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_project(text,text,public.project_type,public.audit_context,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project(text,text,public.project_type,public.audit_context,uuid,uuid) TO transfer_app;
