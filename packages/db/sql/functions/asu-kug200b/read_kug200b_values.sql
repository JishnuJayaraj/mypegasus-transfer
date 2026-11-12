CREATE OR REPLACE FUNCTION public.read_kug200b_values(p_participation_id uuid, p_context public.audit_context, p_keys text[], p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_all jsonb;
  v_result jsonb := '{}';
  k text;
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) = 0
     OR NOT p_keys <@ '{nationality,pensionInsuranceNumber,severeDisability}'::text[]
     OR (SELECT pg_catalog.count(DISTINCT f) FROM pg_catalog.unnest(p_keys) f)
       <> pg_catalog.cardinality(p_keys)
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  v_all := public.open_sensitive_fields(r.id, p_key, p_key_id);
  FOREACH k IN ARRAY p_keys LOOP
    v_result := v_result || pg_catalog.jsonb_build_object(k, v_all -> k);
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_read', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', k), false);
  END LOOP;
  RETURN v_result;
END $function$;

ALTER FUNCTION public.read_kug200b_values(uuid,public.audit_context,text[],text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.read_kug200b_values(uuid,public.audit_context,text[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_kug200b_values(uuid,public.audit_context,text[],text,text) TO transfer_app;
