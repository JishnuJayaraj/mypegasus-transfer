CREATE OR REPLACE FUNCTION public.migrate_agentur_template(p_project_id uuid, p_agentur_key text, p_from_version integer, p_version integer, p_content jsonb, p_sha256 text, p_expected_version integer, p_override_content jsonb, p_base_defaults_version integer, p_context public.audit_context)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_current public.project_config_override;
  v_version integer;
  v_base jsonb;
  v_old jsonb;
  v_new jsonb;
  v_old_keys text[];
  v_kept text[];
  v_removed text[];
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_from_version < 1 OR p_expected_version < 0, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.append_template_pin(p_project_id, p_agentur_key, p_version, p_content, p_sha256,
    p_base_defaults_version, p_context, p_from_version);
  SELECT * INTO v_current FROM public.project_config_override
  WHERE project_id = p_project_id ORDER BY version DESC LIMIT 1;
  v_version := coalesce(v_current.version, 0);
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'override_version_stale';
  END IF;
  IF p_override_content IS NULL THEN
    RETURN v_version;
  END IF;
  v_base := coalesce(v_current.content, '{"kind": "project_override", "schemaVersion": 1}');
  v_old := v_base -> 'agenturSettings' -> p_agentur_key;
  v_new := p_override_content -> 'agenturSettings' -> p_agentur_key;
  v_old_keys := public.scoped_setting_keys(v_old);
  v_kept := public.scoped_setting_keys(v_new);
  SELECT coalesce(pg_catalog.array_agg(k ORDER BY k COLLATE "C"), '{}') INTO v_removed
  FROM pg_catalog.unnest(v_old_keys) k WHERE k <> ALL (v_kept);
  IF coalesce(pg_catalog.jsonb_typeof(p_override_content) <> 'object'
      OR p_override_content ->> 'kind' IS DISTINCT FROM 'project_override'
      OR coalesce(pg_catalog.jsonb_typeof(p_override_content -> 'agenturSettings'), 'object') <> 'object'
      -- Nothing but this Agentur's setting changes (round 27).
      OR public.override_without_agentur(p_override_content, p_agentur_key)
        IS DISTINCT FROM public.override_without_agentur(v_base, p_agentur_key)
      -- At least one key of the current setting goes; none is added or changed.
      OR pg_catalog.cardinality(v_removed) = 0
      OR v_new IS NOT NULL AND (pg_catalog.cardinality(v_kept) = 0
        OR v_new - 'settings' IS DISTINCT FROM v_old - 'settings'
        OR NOT (v_old -> 'settings') @> (v_new -> 'settings')
        OR NOT v_kept <@ v_old_keys), true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.project_config_override (project_id, version, content, created_by)
  VALUES (p_project_id, v_version + 1, p_override_content, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'config_override_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('version', v_version + 1,
      'change', 'agentur_setting_reviewed', 'agenturKey', p_agentur_key,
      'settingKeys', pg_catalog.to_jsonb(v_removed),
      'keptSettingKeys', CASE WHEN pg_catalog.cardinality(v_kept) > 0 THEN pg_catalog.to_jsonb(v_kept) END,
      'baseDefaultsVersion', p_base_defaults_version)), false);
  RETURN v_version + 1;
END $function$;

ALTER FUNCTION public.migrate_agentur_template(uuid,text,integer,integer,jsonb,text,integer,jsonb,integer,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.migrate_agentur_template(uuid,text,integer,integer,jsonb,text,integer,jsonb,integer,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_agentur_template(uuid,text,integer,integer,jsonb,text,integer,jsonb,integer,public.audit_context) TO transfer_app;
