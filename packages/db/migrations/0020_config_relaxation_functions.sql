-- Hand-written (Slice 2 plan, sections 5.2, 5.3 and 5.9; PR 2d-2): rule relaxations with
-- approval and their grants. Same hardening as 0004, 0011, 0014, 0016 and 0018: SECURITY DEFINER
-- owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names, no
-- dynamic SQL, EXECUTE only for transfer_app, refusals as P0001 with a stable code, never a value.
-- The service checks roles and validates the override against every pinned chain first; these
-- check structure, the request's progress and four eyes (round 8: approval before it takes
-- effect, by another person than the requester).

-- Defence in depth for the request record, whoever writes: its identity, rule, reason, requester
-- and request date and instant never change, and the status only moves forward:
--   requested → approved / rejected   decision changes from none to a complete decision
--   requested → withdrawn             no decision, before or after
-- Everything else, a no-op update included, is request_immutable. The table's CHECKs keep the
-- decision complete and the decider apart from the requester.
CREATE FUNCTION config_relaxation_request_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_old_undecided boolean := OLD.decided_by IS NULL AND OLD.decided_on IS NULL AND OLD.decided_at IS NULL;
  v_new_undecided boolean := NEW.decided_by IS NULL AND NEW.decided_on IS NULL AND NEW.decided_at IS NULL;
BEGIN
  IF (NEW.id, NEW.project_id, NEW.rule_id, NEW.reason_code, NEW.requested_by, NEW.requested_on,
      NEW.requested_at) IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.rule_id, OLD.reason_code,
      OLD.requested_by, OLD.requested_on, OLD.requested_at)
     OR NOT coalesce(OLD.status = 'requested' AND v_old_undecided AND CASE NEW.status
       WHEN 'approved' THEN NOT v_new_undecided
       WHEN 'rejected' THEN NOT v_new_undecided
       WHEN 'withdrawn' THEN v_new_undecided
       ELSE false END, false) THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER config_relaxation_request_progresses BEFORE UPDATE ON public.config_relaxation_request
  FOR EACH ROW EXECUTE FUNCTION public.config_relaxation_request_progresses();
--> statement-breakpoint

-- An override's content without the relaxations of one rule; an empty list counts as none: what
-- must stay equal when only that relaxation changes (round 27's exact delta).
CREATE FUNCTION override_without_relaxation(p_content jsonb, p_rule_id text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN r -> 'relax' = '[]'::jsonb THEN r - 'relax' ELSE r END
  FROM (SELECT CASE WHEN pg_catalog.jsonb_typeof(p_content -> 'relax') = 'array'
    THEN pg_catalog.jsonb_set(p_content, '{relax}', coalesce((
      SELECT pg_catalog.jsonb_agg(e.value ORDER BY e.ordinality)
      FROM pg_catalog.jsonb_array_elements(p_content -> 'relax') WITH ORDINALITY e
      WHERE e.value ->> 'ruleId' IS DISTINCT FROM p_rule_id), '[]'::jsonb))
    ELSE p_content END AS r) s
$$;
--> statement-breakpoint

-- The relaxations of one rule in an override's content.
CREATE FUNCTION override_relaxations_of(p_content jsonb, p_rule_id text)
RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT e FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_content -> 'relax') = 'array' THEN p_content -> 'relax'
      ELSE '[]'::jsonb END) e
  WHERE e ->> 'ruleId' = p_rule_id
$$;
--> statement-breakpoint

-- Replaced (signature: + p_rule_id): appends the project's next override version (5.9). As in
-- 0018, the change must be exactly what the audit event claims (round 27): for an Agentur-scoped
-- setting only that Agentur's setting differs, and a set is confirmed by the acting user; for a
-- relaxation only that rule's relaxation differs. A relaxation is added only by an approval this
-- user recorded in this transaction (decide_rule_relaxation; four eyes), with the request's reason
-- code, the approver and the decision date; a removal (tightening) needs no approval. The audit
-- event names the version, the change, the Agentur key, setting keys and source, or the rule id,
-- and the base-defaults version (R26). Returns the new version.
DROP FUNCTION write_project_override(uuid, integer, jsonb, text, text, integer, audit_context);
--> statement-breakpoint
CREATE FUNCTION write_project_override(
  p_project_id uuid, p_expected_version integer, p_content jsonb, p_change text, p_agentur_key text,
  p_base_defaults_version integer, p_context audit_context, p_rule_id text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_current public.project_config_override;
  v_base jsonb;
  v_version integer;
  v_setting jsonb;
  v_keys jsonb;
  v_setting_change boolean := p_change IN ('agentur_setting_set', 'agentur_setting_removed');
  v_request public.config_relaxation_request;
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
      SELECT * INTO v_request FROM public.config_relaxation_request
      WHERE project_id = p_project_id AND rule_id = p_rule_id AND status = 'approved'
        AND decided_by = (p_context).staff_user_id AND decided_at = pg_catalog.now();
      IF NOT FOUND
         OR EXISTS (SELECT FROM public.override_relaxations_of(v_base, p_rule_id))
         OR ARRAY(SELECT public.override_relaxations_of(p_content, p_rule_id))
           IS DISTINCT FROM ARRAY[pg_catalog.jsonb_build_object('ruleId', p_rule_id,
             'reasonCode', v_request.reason_code::text,
             'approvedBy', ((p_context).staff_user_id)::text,
             'approvedOn', v_request.decided_on)] THEN
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
END $$;
--> statement-breakpoint

-- The PL asks to relax one rule (5.9, step 1). The service checked the rule against the current
-- snapshot (it exists in a chain and is operational_default) and the operation; this checks the
-- structure, one open request per rule and that the current override doesn't relax it already.
-- The audit event carries the reason code and the base-defaults version (R26). Returns the id.
CREATE FUNCTION request_rule_relaxation(
  p_project_id uuid, p_rule_id text, p_reason_code relaxation_reason_code, p_requested_on date,
  p_base_defaults_version integer, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_rule_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' OR p_reason_code IS NULL
      OR p_requested_on IS NULL OR p_base_defaults_version < 1, true) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF EXISTS (SELECT FROM public.config_relaxation_request
      WHERE project_id = p_project_id AND rule_id = p_rule_id AND status = 'requested') THEN
    RAISE EXCEPTION 'relaxation_request_open';
  END IF;
  IF EXISTS (SELECT FROM public.override_relaxations_of((SELECT content
      FROM public.project_config_override WHERE project_id = p_project_id
      ORDER BY version DESC LIMIT 1), p_rule_id)) THEN
    RAISE EXCEPTION 'relaxation_exists';
  END IF;
  INSERT INTO public.config_relaxation_request (project_id, rule_id, reason_code, status,
    requested_by, requested_on)
  VALUES (p_project_id, p_rule_id, p_reason_code, 'requested', (p_context).staff_user_id,
    p_requested_on)
  RETURNING id INTO v_id;
  PERFORM public.write_audit_event(p_project_id, NULL, 'rule_relaxation_requested', p_context, NULL,
    NULL, NULL, p_reason_code::text, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', v_id,
      'ruleId', p_rule_id, 'baseDefaultsVersion', p_base_defaults_version), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Locks the project of a request (the project lock first, D3) and returns the request, locked;
-- it must still be pending, and the actor a user acting in person.
CREATE FUNCTION lock_relaxation_request(p_request_id uuid, p_context audit_context)
RETURNS public.config_relaxation_request LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_project_id uuid;
  v_request public.config_relaxation_request;
BEGIN
  SELECT project_id INTO v_project_id FROM public.config_relaxation_request WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO v_request FROM public.config_relaxation_request WHERE id = p_request_id FOR UPDATE;
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'relaxation_not_open';
  END IF;
  RETURN v_request;
END $$;
--> statement-breakpoint

-- Another person decides a pending request (5.9 step 3, R2; four eyes in SQL as well as in the
-- table's CHECK). An approval takes effect only here: in the same transaction the next override
-- version adds { ruleId, reasonCode, approvedBy, approvedOn } (write_project_override with the
-- content the service validated against every chain). A rejection changes no configuration and
-- takes no override arguments. Returns the decision's audit event.
CREATE FUNCTION decide_rule_relaxation(
  p_request_id uuid, p_approve boolean, p_decided_on date, p_context audit_context,
  p_expected_version integer DEFAULT NULL, p_content jsonb DEFAULT NULL,
  p_base_defaults_version integer DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.config_relaxation_request;
  v_version integer;
BEGIN
  v_request := public.lock_relaxation_request(p_request_id, p_context);
  IF p_approve IS NULL OR p_decided_on IS NULL
     OR NOT p_approve AND (p_expected_version, p_content, p_base_defaults_version) IS DISTINCT FROM
       (NULL::integer, NULL::jsonb, NULL::integer) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF v_request.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  UPDATE public.config_relaxation_request SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.relaxation_request_status,
    decided_by = (p_context).staff_user_id, decided_on = p_decided_on, decided_at = pg_catalog.now()
  WHERE id = p_request_id;
  IF NOT p_approve THEN
    RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_rejected', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', p_request_id,
        'ruleId', v_request.rule_id), false);
  END IF;
  v_version := public.write_project_override(v_request.project_id, p_expected_version, p_content,
    'relaxation_added', NULL, p_base_defaults_version, p_context, v_request.rule_id);
  RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_approved', p_context,
    NULL, NULL, NULL, v_request.reason_code::text, NULL, pg_catalog.jsonb_build_object(
      'relaxationRequestId', p_request_id, 'ruleId', v_request.rule_id, 'version', v_version,
      'baseDefaultsVersion', p_base_defaults_version), false);
END $$;
--> statement-breakpoint

-- The PL withdraws a pending request (5.9 step 4); nothing changes in the configuration.
CREATE FUNCTION withdraw_rule_relaxation(p_request_id uuid, p_context audit_context)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.config_relaxation_request;
BEGIN
  v_request := public.lock_relaxation_request(p_request_id, p_context);
  UPDATE public.config_relaxation_request SET status = 'withdrawn' WHERE id = p_request_id;
  RETURN public.write_audit_event(v_request.project_id, NULL, 'rule_relaxation_withdrawn', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('relaxationRequestId', p_request_id,
      'ruleId', v_request.rule_id), false);
END $$;
--> statement-breakpoint

-- Replaced: the relaxation event types are written only by their functions too (AC-40).
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
      'config_template_pinned', 'config_override_changed', 'rule_relaxation_requested',
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn') THEN
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

-- Grants (plan 5.3): requests are written only through their functions; the API reads them to
-- show the open requests (5.12).
GRANT SELECT ON TABLE config_relaxation_request TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION config_relaxation_request_progresses, override_without_relaxation,
  override_relaxations_of, write_project_override, request_rule_relaxation, lock_relaxation_request,
  decide_rule_relaxation, withdraw_rule_relaxation FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION write_project_override, request_rule_relaxation, decide_rule_relaxation,
  withdraw_rule_relaxation TO transfer_app;
