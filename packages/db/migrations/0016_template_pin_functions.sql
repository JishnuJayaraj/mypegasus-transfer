-- Hand-written (Slice 2 plan, sections 5.2, 5.3 and 5.8; PR 2c-2; rounds 22–23): template pins,
-- the Project Agentur, and their grants. Same hardening as 0004, 0011 and 0014: SECURITY DEFINER
-- owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no
-- dynamic SQL, EXECUTE only for transfer_app, refusals as P0001 with a stable code, never a value.

-- Template versions and pins are never changed or removed (D5, AC-10): no grant, and this trigger
-- refuses UPDATE and DELETE for every role, the owner included.
CREATE FUNCTION refuse_config_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER config_template_version_append_only BEFORE UPDATE OR DELETE ON public.config_template_version
  FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
--> statement-breakpoint
CREATE TRIGGER project_template_pin_append_only BEFORE UPDATE OR DELETE ON public.project_template_pin
  FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
--> statement-breakpoint

-- Pins a template version for a project (D5). The service reads the file through loadTemplate and
-- computes its canonical SHA-256 (R22). The first pin of a version anywhere registers it; a
-- concurrent first pin waits on the primary key and then compares. Every later pin, of any
-- project, must supply the stored content (jsonb equality) and the stored hash, or is refused
-- (`template_version_changed`). Lock order: project, then the template version (D3, R28).
-- The audit event carries key, version, the replaced version and the base-defaults version (R26).
-- Returns the pin's id.
CREATE FUNCTION pin_agentur_template(
  p_project_id uuid, p_agentur_key text, p_version integer, p_content jsonb, p_sha256 text,
  p_base_defaults_version integer, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := pg_catalog.gen_random_uuid();
  v_stored public.config_template_version;
  v_previous integer;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_version < 1 OR p_sha256 !~ '^[0-9a-f]{64}$'
      OR p_base_defaults_version < 1 OR pg_catalog.jsonb_typeof(p_content) <> 'object'
      OR p_content ->> 'kind' IS DISTINCT FROM 'regional_template'
      OR p_content ->> 'agenturKey' IS DISTINCT FROM p_agentur_key
      OR p_content -> 'version' IS DISTINCT FROM pg_catalog.to_jsonb(p_version), true) THEN
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
  IF v_previous = p_version THEN
    RAISE EXCEPTION 'template_already_pinned';
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

-- Replaced: also sets the Project Agentur (Q90, R12), only while draft and only to an Agentur the
-- project has pinned, so a Project Agentur always has its snapshot. The audit event names the key
-- (a catalog key, not free text). Otherwise as in 0011.
DROP FUNCTION update_project(uuid, audit_context, text, text, project_type);
--> statement-breakpoint
CREATE FUNCTION update_project(
  p_id uuid, p_context audit_context, p_name text DEFAULT NULL, p_customer_name text DEFAULT NULL,
  p_type project_type DEFAULT NULL, p_project_agentur_key text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project;
  v_fields text[] := '{}';
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  IF p_name IS NOT NULL AND NOT public.project_text_valid(p_name)
     OR p_customer_name IS NOT NULL AND NOT public.project_text_valid(p_customer_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_name IS DISTINCT FROM r.name AND p_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF p_customer_name IS DISTINCT FROM r.customer_name AND p_customer_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'customerName');
  END IF;
  IF p_type IS DISTINCT FROM r.type AND p_type IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF EXISTS (SELECT FROM public.participation WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_participations';
    ELSIF EXISTS (SELECT FROM public.project_entry_wave WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_waves';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'type');
  END IF;
  IF p_project_agentur_key IS DISTINCT FROM r.project_agentur_key AND p_project_agentur_key IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF NOT EXISTS (SELECT FROM public.project_template_pin
                      WHERE project_id = p_id AND agentur_key = p_project_agentur_key) THEN
      RAISE EXCEPTION 'agentur_not_pinned';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'projectAgenturKey');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'project_unchanged';
  END IF;
  UPDATE public.project
  SET name = coalesce(p_name, name), customer_name = coalesce(p_customer_name, customer_name),
      type = coalesce(p_type, type),
      project_agentur_key = coalesce(p_project_agentur_key, project_agentur_key)
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_changed', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'type', CASE WHEN 'type' = ANY (v_fields) THEN p_type END,
      'projectAgenturKey', CASE WHEN 'projectAgenturKey' = ANY (v_fields) THEN p_project_agentur_key END)),
    false);
END $$;
--> statement-breakpoint

-- Replaced: the pin event type is written only by its own function too.
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
      'config_template_pinned') THEN
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

-- Grants (plan 5.3): versions and pins are written only through pin_agentur_template; the API
-- reads them to resolve a project's snapshot.
GRANT SELECT ON TABLE config_template_version, project_template_pin TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION refuse_config_change, pin_agentur_template, update_project FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pin_agentur_template, update_project TO transfer_app;
