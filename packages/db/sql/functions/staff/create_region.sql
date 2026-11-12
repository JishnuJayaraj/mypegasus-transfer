CREATE OR REPLACE FUNCTION public.create_region(p_code text, p_name text, p_actor uuid, p_request_id text, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF NOT public.region_code_valid(p_code) OR NOT public.staff_text_valid(p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  BEGIN
    INSERT INTO public.region (id, code, name) VALUES (v_id, p_code, p_name);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'region_code_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, details, request_id)
  VALUES ('region_created', p_actor, pg_catalog.jsonb_build_object('regionId', v_id), p_request_id);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.create_region(text,text,uuid,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_region(text,text,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_region(text,text,uuid,text,uuid) TO transfer_app;
