-- Hand-written (Slice 2 plan, sections 5.3 and 5.6; PR 2b; rounds 22–23): creating and editing
-- entry waves. Same hardening as 0004 and 0011: SECURITY DEFINER owned by transfer_owner, a fixed
-- search_path with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for
-- transfer_app, refusals as P0001 with a stable code, never a value. The service checks the rules
-- of checkWaveChange under the same lock first; the functions check structure (the table CHECKs
-- hold the date order).

-- A wave's code and name: the code an identifier, the name trimmed UI text of 1–100 characters
-- without control characters (the domain's checkWaveChange). Never null.
CREATE FUNCTION entry_wave_text_valid(p_code text, p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_code ~ '^[A-Za-z0-9_-]{1,20}$' AND p_name = pg_catalog.btrim(p_name)
    AND pg_catalog.length(p_name) BETWEEN 1 AND 100 AND p_name !~ '[[:cntrl:]]', false)
$$;
--> statement-breakpoint

-- A new wave of a ta_tg project. The audit event carries the wave id and its dates; code and name
-- stay on the row (no free text in the trail, Q66). Returns the wave's id.
CREATE FUNCTION create_entry_wave(
  p_project_id uuid, p_code text, p_name text, p_context audit_context,
  p_signing_deadline date DEFAULT NULL, p_default_tg_start date DEFAULT NULL,
  p_default_tg_end date DEFAULT NULL, p_latest_entry_date date DEFAULT NULL, p_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid := coalesce(p_id, pg_catalog.gen_random_uuid());
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT public.entry_wave_text_valid(p_code, p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.project_entry_wave (id, project_id, code, name, signing_deadline, default_tg_start,
    default_tg_end, latest_entry_date)
  VALUES (v_id, p_project_id, p_code, p_name, p_signing_deadline, p_default_tg_start, p_default_tg_end,
    p_latest_entry_date);
  PERFORM public.write_audit_event(p_project_id, NULL, 'entry_wave_created', p_context, NULL, NULL, NULL,
    NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('waveId', v_id,
      'signingDeadline', p_signing_deadline,
      'defaultTgStart', p_default_tg_start, 'defaultTgEnd', p_default_tg_end,
      'latestEntryDate', p_latest_entry_date)), false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Replaces a wave's code, name and dates with the given values (a null date is cleared). A change
-- to the current values is refused without a write (`wave_unchanged`). The audit event lists the
-- changed keys and each changed date's old and new value, never the code or name. Returns the
-- event's id.
CREATE FUNCTION update_entry_wave(
  p_project_id uuid, p_id uuid, p_code text, p_name text, p_signing_deadline date,
  p_default_tg_start date, p_default_tg_end date, p_latest_entry_date date, p_context audit_context
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.project_entry_wave;
  v_type public.project_type;
  v_fields text[];
  v_dates jsonb;
BEGIN
  -- The exclusive project lock is the first operation (D3, round 23).
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project_entry_wave WHERE id = p_id AND project_id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wave_not_found';
  END IF;
  -- Defended here too, not only by the service (round 24).
  SELECT type INTO v_type FROM public.project WHERE id = p_project_id;
  IF v_type <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT public.entry_wave_text_valid(p_code, p_name) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}'),
    pg_catalog.jsonb_object_agg(c.field, pg_catalog.jsonb_build_object('from', c.old, 'to', c.new))
      FILTER (WHERE c.ord > 2)
  INTO v_fields, v_dates
  FROM (VALUES (1, 'code', pg_catalog.to_jsonb(r.code), pg_catalog.to_jsonb(p_code)),
    (2, 'name', pg_catalog.to_jsonb(r.name), pg_catalog.to_jsonb(p_name)),
    (3, 'signingDeadline', pg_catalog.to_jsonb(r.signing_deadline), pg_catalog.to_jsonb(p_signing_deadline)),
    (4, 'defaultTgStart', pg_catalog.to_jsonb(r.default_tg_start), pg_catalog.to_jsonb(p_default_tg_start)),
    (5, 'defaultTgEnd', pg_catalog.to_jsonb(r.default_tg_end), pg_catalog.to_jsonb(p_default_tg_end)),
    (6, 'latestEntryDate', pg_catalog.to_jsonb(r.latest_entry_date), pg_catalog.to_jsonb(p_latest_entry_date))
  ) AS c(ord, field, old, new)
  WHERE c.old IS DISTINCT FROM c.new;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'wave_unchanged';
  END IF;
  UPDATE public.project_entry_wave
  SET code = p_code, name = p_name, signing_deadline = p_signing_deadline,
      default_tg_start = p_default_tg_start, default_tg_end = p_default_tg_end,
      latest_entry_date = p_latest_entry_date, updated_at = pg_catalog.now()
  WHERE id = p_id;
  RETURN public.write_audit_event(p_project_id, NULL, 'entry_wave_changed', p_context, NULL, NULL, NULL,
    NULL, NULL, pg_catalog.jsonb_build_object('waveId', p_id, 'fields', pg_catalog.to_jsonb(v_fields))
      || CASE WHEN v_dates IS NULL THEN '{}' ELSE pg_catalog.jsonb_build_object('dates', v_dates) END,
    false);
END $$;
--> statement-breakpoint

-- Replaced: the wave event types are written only by their own functions too.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed') THEN
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

-- Grants (plan 5.3): waves are written only through the functions above; transfer_app keeps
-- SELECT on project_entry_wave and has no DML on it.
REVOKE ALL ON FUNCTION entry_wave_text_valid, create_entry_wave, update_entry_wave FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_entry_wave, update_entry_wave TO transfer_app;
