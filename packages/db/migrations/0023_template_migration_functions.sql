-- Hand-written (Slice 2 plan, sections 5.3, 5.8 and 5.9; PR 2e-2; Q36, Q93, R15, R26): template
-- version migration with review, and its grants. Same hardening as 0004, 0011, 0016, 0018, 0020
-- and 0022: SECURITY DEFINER owned by transfer_owner, a fixed search_path with pg_temp last,
-- schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app, refusals as P0001 with a
-- stable code, never a value. The service decides on the snapshot under the exclusive project lock
-- first (planTemplateMigration, the review, validateProjectOverride); these re-check structure.

-- Internal (no grant): registers a template version and appends a pin, the body of 0016's
-- pin_agentur_template. Without p_from_version it is a first pin of the Agentur in the project
-- (an Agentur pinned already is template_already_pinned, whatever the version): a pinned Agentur
-- changes its version only through migrate_agentur_template, with its review (R15). With
-- p_from_version it is that migration: the Agentur is pinned, the version is newer than the pinned
-- one, and the pinned one is still p_from_version (pin_version_stale otherwise). The audit event
-- carries key, version, the replaced version and the base-defaults version (R26). Returns the
-- pin's id.
CREATE FUNCTION append_template_pin(
  p_project_id uuid, p_agentur_key text, p_version integer, p_content jsonb, p_sha256 text,
  p_base_defaults_version integer, p_context audit_context, p_from_version integer
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
  ELSIF p_version = v_previous THEN
    RAISE EXCEPTION 'template_already_pinned';
  ELSIF p_version < v_previous THEN
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
END $$;
--> statement-breakpoint

-- Replaced (same signature, so owner, SECURITY DEFINER and the EXECUTE grant stay): the first pin
-- of an Agentur in the project only (D5). Another version of a pinned Agentur was a plain pin
-- before; now it is template_already_pinned, and the version changes only through
-- migrate_agentur_template (R15, round 28: enforced here, never left to the service).
CREATE OR REPLACE FUNCTION pin_agentur_template(
  p_project_id uuid, p_agentur_key text, p_version integer, p_content jsonb, p_sha256 text,
  p_base_defaults_version integer, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  RETURN public.append_template_pin(p_project_id, p_agentur_key, p_version, p_content, p_sha256,
    p_base_defaults_version, p_context, NULL);
END $$;
--> statement-breakpoint

-- The keys (`step.key`) of an Agentur-scoped setting's settings, sorted; empty for none.
CREATE FUNCTION scoped_setting_keys(p_setting jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(pg_catalog.array_agg(s.key || '.' || k ORDER BY (s.key || '.' || k) COLLATE "C"), '{}')
  FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(p_setting -> 'settings') = 'object'
    THEN p_setting -> 'settings' ELSE '{}'::jsonb END) s
  CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(
    CASE WHEN pg_catalog.jsonb_typeof(s.value) = 'object' THEN s.value ELSE '{}'::jsonb END) k
$$;
--> statement-breakpoint

-- Migrates a pinned Agentur to a newer template version (plan 5.8, Q36), with the review of its
-- Agentur-scoped setting (Q93, R15), in one call under the exclusive project lock: the new pin
-- (append_template_pin with the pinned version the review was made on), the expected override
-- version (override_version_stale), and, when the review removes keys, the next override version
-- with the change `agentur_setting_reviewed`. Only this function writes that change, in the
-- call that pins the new version, so no review removal exists without its migration and the
-- granted override write can't make one (it refuses the kind). Its exact delta (round 27): apart
-- from this Agentur's setting the content is the current one, the setting keeps its source and
-- confirmation, and its settings are the current ones with at least one key removed and no value
-- changed (or the setting is gone with its last key). The audit event names the removed keys
-- (`settingKeys`), the kept ones and the base-defaults version (R26), computed here. Returns the
-- override version after the migration.
CREATE FUNCTION migrate_agentur_template(
  p_project_id uuid, p_agentur_key text, p_from_version integer, p_version integer, p_content jsonb,
  p_sha256 text, p_expected_version integer, p_override_content jsonb, p_base_defaults_version integer,
  p_context audit_context
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Grants (plan 5.3): a migration goes only through migrate_agentur_template; its helpers are
-- internal.
REVOKE ALL ON FUNCTION append_template_pin, scoped_setting_keys, migrate_agentur_template FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION migrate_agentur_template TO transfer_app;
