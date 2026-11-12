CREATE OR REPLACE FUNCTION public.append_project_override(p_project_id uuid, p_expected_version integer, p_content jsonb, p_change text, p_agentur_key text, p_base_defaults_version integer, p_context public.audit_context, p_rule_id text, p_relaxation jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_current public.project_config_override;
  v_base jsonb;
  v_version integer;
  v_setting jsonb;
  v_keys jsonb;
  v_setting_change boolean := p_change IN ('agentur_setting_set', 'agentur_setting_removed');
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_expected_version < 0 OR p_base_defaults_version < 1
      OR pg_catalog.jsonb_typeof(p_content) <> 'object'
      OR p_content ->> 'kind' IS DISTINCT FROM 'project_override'
      OR coalesce(pg_catalog.jsonb_typeof(p_content -> 'agenturSettings'), 'object') <> 'object'
      OR coalesce(pg_catalog.jsonb_typeof(p_content -> 'relax'), 'array') <> 'array'
      OR p_change NOT IN ('agentur_setting_set', 'agentur_setting_removed', 'relaxation_added',
        'relaxation_removed')
      OR CASE WHEN v_setting_change
        THEN p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_rule_id IS NOT NULL
        ELSE p_rule_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' OR p_agentur_key IS NOT NULL END, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO v_current FROM public.project_config_override
  WHERE project_id = p_project_id ORDER BY version DESC LIMIT 1;
  v_version := coalesce(v_current.version, 0);
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'override_version_stale';
  END IF;
  v_base := coalesce(v_current.content, '{"kind": "project_override", "schemaVersion": 1}');
  IF p_content = v_base THEN
    RAISE EXCEPTION 'override_unchanged';
  END IF;
  IF v_setting_change THEN
    -- Nothing but the named Agentur's setting changes: no field, rule, relaxation or other
    -- Agentur slips in under this audit event (round 27).
    IF public.override_without_agentur(p_content, p_agentur_key)
       IS DISTINCT FROM public.override_without_agentur(v_base, p_agentur_key) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    -- A set names the setting in the new content with a known source, confirmed by the acting
    -- user; a removal one the current content has and the new one hasn't.
    IF p_change = 'agentur_setting_set' THEN
      v_setting := p_content -> 'agenturSettings' -> p_agentur_key;
      IF coalesce(v_setting ->> 'source' NOT IN ('phone_call_agentur', 'email_agentur',
          'letter_agentur', 'meeting_agentur'), true)
         OR v_setting ->> 'confirmedBy' IS DISTINCT FROM ((p_context).staff_user_id)::text THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
    ELSE
      v_setting := v_current.content -> 'agenturSettings' -> p_agentur_key;
      IF p_content -> 'agenturSettings' -> p_agentur_key IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
    END IF;
    SELECT pg_catalog.jsonb_agg(s.key || '.' || k ORDER BY (s.key || '.' || k) COLLATE "C") INTO v_keys
    FROM pg_catalog.jsonb_each(v_setting -> 'settings') s
    CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(
      CASE WHEN pg_catalog.jsonb_typeof(s.value) = 'object' THEN s.value END) k;
    IF v_keys IS NULL THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSE
    -- Nothing but this rule's relaxation changes (round 27's exact delta).
    IF public.override_without_relaxation(p_content, p_rule_id)
       IS DISTINCT FROM public.override_without_relaxation(v_base, p_rule_id) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    IF p_change = 'relaxation_added' THEN
      IF p_relaxation IS NULL
         OR EXISTS (SELECT FROM public.override_relaxations_of(v_base, p_rule_id))
         OR ARRAY(SELECT public.override_relaxations_of(p_content, p_rule_id))
           IS DISTINCT FROM ARRAY[p_relaxation] THEN
        RAISE EXCEPTION 'invalid_argument';
      END IF;
    ELSIF NOT EXISTS (SELECT FROM public.override_relaxations_of(v_base, p_rule_id))
       OR EXISTS (SELECT FROM public.override_relaxations_of(p_content, p_rule_id)) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END IF;
  INSERT INTO public.project_config_override (project_id, version, content, created_by)
  VALUES (p_project_id, v_version + 1, p_content, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'config_override_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('version', v_version + 1,
      'change', p_change, 'agenturKey', p_agentur_key, 'settingKeys', v_keys,
      'source', CASE WHEN p_change = 'agentur_setting_set' THEN v_setting ->> 'source' END,
      'ruleId', p_rule_id, 'baseDefaultsVersion', p_base_defaults_version)), false);
  RETURN v_version + 1;
END $function$;

ALTER FUNCTION public.append_project_override(uuid,integer,jsonb,text,text,integer,public.audit_context,text,jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.append_project_override(uuid,integer,jsonb,text,text,integer,public.audit_context,text,jsonb) FROM PUBLIC;
