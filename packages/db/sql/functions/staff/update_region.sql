CREATE OR REPLACE FUNCTION public.update_region(p_id uuid, p_actor uuid, p_request_id text, p_code text DEFAULT NULL::text, p_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.region;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.assert_global_admin(p_actor);
  IF p_code IS NOT NULL AND NOT public.region_code_valid(p_code)
     OR p_name IS NOT NULL AND NOT public.staff_text_valid(p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.region WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'region_not_found';
  END IF;
  IF p_code IS NOT NULL AND p_code <> r.code THEN
    v_fields := pg_catalog.array_append(v_fields, 'code');
  END IF;
  IF p_name IS NOT NULL AND p_name <> r.name THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'region_unchanged';
  END IF;
  BEGIN
    UPDATE public.region SET code = coalesce(p_code, code), name = coalesce(p_name, name)
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'region_code_taken';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, details, request_id)
  VALUES ('region_changed', p_actor,
    pg_catalog.jsonb_build_object('regionId', p_id, 'fields', pg_catalog.to_jsonb(v_fields)), p_request_id);
END $function$;

ALTER FUNCTION public.update_region(uuid,uuid,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.update_region(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_region(uuid,uuid,text,text,text) TO transfer_app;
