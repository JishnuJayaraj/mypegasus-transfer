CREATE OR REPLACE FUNCTION public.append_template_pin(p_project_id uuid, p_agentur_key text, p_version integer, p_content jsonb, p_sha256 text, p_base_defaults_version integer, p_context public.audit_context, p_from_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := pg_catalog.gen_random_uuid();
  v_stored public.config_template_version;
  v_previous integer;
BEGIN
  IF coalesce(p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_version < 1 OR p_sha256 !~ '^[0-9a-f]{64}$'
      OR p_base_defaults_version < 1 OR pg_catalog.jsonb_typeof(p_content) <> 'object'
      OR p_content ->> 'kind' IS DISTINCT FROM 'regional_template'
      OR p_content ->> 'agenturKey' IS DISTINCT FROM p_agentur_key
      OR p_content -> 'version' IS DISTINCT FROM pg_catalog.to_jsonb(p_version), true)
     OR p_from_version < 1 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.config_template_version (agentur_key, version, content, content_sha256)
  VALUES (p_agentur_key, p_version, p_content, p_sha256)
  ON CONFLICT (agentur_key, version) DO NOTHING;
  SELECT * INTO v_stored FROM public.config_template_version
  WHERE agentur_key = p_agentur_key AND version = p_version;
  -- Both: the same claimed hash with other content fails too (round 22).
  IF v_stored.content <> p_content OR v_stored.content_sha256 <> p_sha256 THEN
    RAISE EXCEPTION 'template_version_changed';
  END IF;
  SELECT version INTO v_previous FROM public.project_template_pin
  WHERE project_id = p_project_id AND agentur_key = p_agentur_key ORDER BY seq DESC LIMIT 1;
  IF p_from_version IS NULL THEN
    IF v_previous IS NOT NULL THEN
      RAISE EXCEPTION 'template_already_pinned';
    END IF;
  ELSIF v_previous IS NULL THEN
    RAISE EXCEPTION 'agentur_not_pinned';
  -- The target against the version the review was made on, then whether the pin moved since
  -- (round 31): a pin another migration moved, to the target or beyond it, is always stale.
  ELSIF p_version = p_from_version THEN
    RAISE EXCEPTION 'template_already_pinned';
  ELSIF p_version < p_from_version THEN
    RAISE EXCEPTION 'template_version_not_newer';
  ELSIF v_previous <> p_from_version THEN
    RAISE EXCEPTION 'pin_version_stale';
  END IF;
  INSERT INTO public.project_template_pin (id, project_id, agentur_key, version, pinned_by)
  VALUES (v_id, p_project_id, p_agentur_key, p_version, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'config_template_pinned', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('agenturKey', p_agentur_key,
      'version', p_version, 'previousVersion', v_previous,
      'baseDefaultsVersion', p_base_defaults_version)), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.append_template_pin(uuid,text,integer,jsonb,text,integer,public.audit_context,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.append_template_pin(uuid,text,integer,jsonb,text,integer,public.audit_context,integer) FROM PUBLIC;
