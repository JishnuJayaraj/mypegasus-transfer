CREATE OR REPLACE FUNCTION public.pin_agentur_template(p_project_id uuid, p_agentur_key text, p_version integer, p_content jsonb, p_sha256 text, p_base_defaults_version integer, p_context public.audit_context)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  RETURN public.append_template_pin(p_project_id, p_agentur_key, p_version, p_content, p_sha256,
    p_base_defaults_version, p_context, NULL);
END $function$;

ALTER FUNCTION public.pin_agentur_template(uuid,text,integer,jsonb,text,integer,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.pin_agentur_template(uuid,text,integer,jsonb,text,integer,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pin_agentur_template(uuid,text,integer,jsonb,text,integer,public.audit_context) TO transfer_app;
