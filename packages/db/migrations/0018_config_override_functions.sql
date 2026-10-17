-- Hand-written (Slice 2 plan, sections 5.2, 5.3 and 5.9; PR 2d-1): project override versions and
-- their grants. Same hardening as 0004, 0011, 0014 and 0016: SECURITY DEFINER owned by
-- transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL,
-- EXECUTE only for transfer_app, refusals as P0001 with a stable code, never a value.

-- Override versions are never changed or removed (plan 5.2), like template versions and pins: no
-- grant, and the 0016 trigger function refuses UPDATE and DELETE for every role.
CREATE TRIGGER project_config_override_append_only BEFORE UPDATE OR DELETE ON public.project_config_override
  FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
--> statement-breakpoint

-- An override's content without one Agentur's scoped setting; an empty map counts as none
-- (round 27): what must stay equal when only that Agentur's setting changes.
CREATE FUNCTION override_without_agentur(p_content jsonb, p_agentur_key text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN r -> 'agenturSettings' = '{}'::jsonb THEN r - 'agenturSettings' ELSE r END
  FROM (SELECT pg_catalog.jsonb_delete_path(p_content, ARRAY['agenturSettings', p_agentur_key]) AS r) s
$$;
--> statement-breakpoint

-- Appends the project's next override version (5.9). The service validates the content against
-- every pinned chain first (validateProjectOverride, D2 as amended in round 26); this checks its
-- structure and that the change is exactly what it claims (round 27): only the named Agentur's
-- setting differs from the current content, and a set is confirmed by the acting user (R14). Optimistic concurrency under the exclusive
-- project lock: the expected version must be the current one (0 = no override yet), else
-- `override_version_stale`; the current content again is `override_unchanged`. The audit event
-- names the version, the change, the Agentur key, the setting keys (`step.key`, computed here
-- from the set or removed setting) and the source of a set, never a value; and the base-defaults
-- version (R26). Returns the new version.
CREATE FUNCTION write_project_override(
  p_project_id uuid, p_expected_version integer, p_content jsonb, p_change text, p_agentur_key text,
  p_base_defaults_version integer, p_context audit_context
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_current public.project_config_override;
  v_base jsonb;
  v_version integer;
  v_setting jsonb;
  v_keys jsonb;
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
      OR p_change NOT IN ('agentur_setting_set', 'agentur_setting_removed')
      OR p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$', true) THEN
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
  -- Nothing but the named Agentur's setting changes: no field, rule, relaxation or other Agentur
  -- slips in under this audit event (round 27).
  IF public.override_without_agentur(p_content, p_agentur_key)
     IS DISTINCT FROM public.override_without_agentur(v_base, p_agentur_key) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- A set names the setting in the new content with a known source, confirmed by the acting user;
  -- a removal one the current content has and the new one hasn't.
  IF p_change = 'agentur_setting_set' THEN
    v_setting := p_content -> 'agenturSettings' -> p_agentur_key;
    IF coalesce(v_setting ->> 'source' NOT IN ('phone_call_agentur', 'email_agentur', 'letter_agentur',
        'meeting_agentur'), true)
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
  INSERT INTO public.project_config_override (project_id, version, content, created_by)
  VALUES (p_project_id, v_version + 1, p_content, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'config_override_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('version', v_version + 1,
      'change', p_change, 'agenturKey', p_agentur_key, 'settingKeys', v_keys,
      'source', CASE WHEN p_change = 'agentur_setting_set' THEN v_setting ->> 'source' END,
      'baseDefaultsVersion', p_base_defaults_version)), false);
  RETURN v_version + 1;
END $$;
--> statement-breakpoint

-- Replaced: the override event type is written only by its own function too (AC-40).
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed',
      'config_template_pinned', 'config_override_changed') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context, NULL, NULL,
    NULL, p_reason_code, p_effective_date, p_details, coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

-- Grants (plan 5.3): override versions are written only through write_project_override; the API
-- reads them to resolve a project's snapshot (R11).
GRANT SELECT ON TABLE project_config_override TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION override_without_agentur, write_project_override FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION write_project_override TO transfer_app;
