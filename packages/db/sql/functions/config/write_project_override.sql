CREATE OR REPLACE FUNCTION public.write_project_override(p_project_id uuid, p_expected_version integer, p_content jsonb, p_change text, p_agentur_key text, p_base_defaults_version integer, p_context public.audit_context, p_rule_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  IF p_change IS NOT DISTINCT FROM 'relaxation_added' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  RETURN public.append_project_override(p_project_id, p_expected_version, p_content, p_change,
    p_agentur_key, p_base_defaults_version, p_context, p_rule_id, NULL);
END $function$;

ALTER FUNCTION public.write_project_override(uuid,integer,jsonb,text,text,integer,public.audit_context,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_project_override(uuid,integer,jsonb,text,text,integer,public.audit_context,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_project_override(uuid,integer,jsonb,text,text,integer,public.audit_context,text) TO transfer_app;
