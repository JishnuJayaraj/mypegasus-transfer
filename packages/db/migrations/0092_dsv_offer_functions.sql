-- Offers bind status changes to the paper (process-and-lifecycle.md, DSV offers).
GRANT SELECT ON public.dsv_offer TO transfer_app;
CREATE UNIQUE INDEX dsv_offer_one_open ON public.dsv_offer(participation_id) WHERE ended_as IS NULL;
ALTER TABLE public.dsv_offer ADD CONSTRAINT dsv_offer_origin CHECK (
  origin IN ('generated', 'external_paper') AND (origin = 'generated') = (generation_id IS NOT NULL));
ALTER TABLE public.dsv_offer ADD CONSTRAINT dsv_offer_end CHECK (
  (ended_as IS NULL) = (ended_at IS NULL) AND (ended_as IS NULL OR ended_as IN ('signed', 'declined', 'expired')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION apply_status_change(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL,
  p_activation boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_type public.project_type;
  v_track public.lifecycle_track;
  v_ending boolean := p_field = 'status' AND p_to IN ('withdrawn', 'exited');
  v_secondary public.end_reason[] := coalesce(p_secondary_reasons, '{}');
  v_signing_deadline date;
  v_event uuid;
  v_request public.profiling_exception_request;
  v_stale public.profiling_exception_superseded_reason;
  v_signed_on date;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system,participant}');
  IF p_field IS NULL OR p_to IS NULL OR p_activation IS NULL
     OR p_activation AND p_entry_kind IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (D9, R1, Q98): no transition of a draft project, manual or system. The shared
  -- project lock taken above serialises this with activate_project.
  IF (SELECT status FROM public.project WHERE id = r.project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF p_expected_from IS DISTINCT FROM (CASE p_field
       WHEN 'status' THEN r.status::text
       WHEN 'profiling_status' THEN r.profiling_status::text
       ELSE r.dsv_status::text END) THEN
    RAISE EXCEPTION 'stale_status';
  END IF;

  SELECT type INTO v_type FROM public.project WHERE id = r.project_id;
  SELECT * INTO v_request FROM public.profiling_exception_request WHERE id = r.profiling_exception_request_id;
  v_track := CASE p_field WHEN 'status' THEN 'main' WHEN 'profiling_status' THEN 'profiling' ELSE 'dsv' END;
  IF NOT EXISTS (
    SELECT FROM public.lifecycle_edge e
    WHERE e.track = v_track AND e.from_value = p_expected_from AND e.to_value = p_to
      AND (p_context).actor_type = ANY (e.actors)
      AND (e.project_types IS NULL OR v_type = ANY (e.project_types))
      AND (CASE WHEN p_activation THEN e.kind = 'activation'
                WHEN p_entry_kind IS NULL THEN e.kind IN ('manual', 'system')
                ELSE e.kind::text = p_entry_kind::text END)
  ) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  -- Track activity (plan 5.3): the tracks move while `informed` (DSV only in ta_tg); in the TG
  -- with an approved exception, profiling moves forward or is declined (Q74).
  IF v_track = 'dsv' AND NOT (r.status = 'informed' AND v_type = 'ta_tg')
     OR v_track = 'profiling' AND NOT (r.status = 'informed'
       OR r.status = 'active_in_tg' AND v_request.status IS NOT DISTINCT FROM 'approved' AND p_expected_from <> 'profiling_declined') THEN
    RAISE EXCEPTION 'track_inactive';
  END IF;

  IF v_ending THEN
    IF p_end_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required';
    END IF;
    IF NOT public.end_reason_fits(p_to::public.main_status, p_end_reason) THEN
      RAISE EXCEPTION 'reason_wrong_phase';
    END IF;
    -- Special category: not storable until encrypted storage exists (Q66).
    IF 'long_term_illness_reduced_earning_capacity' = ANY (p_end_reason || v_secondary) THEN
      RAISE EXCEPTION 'reason_not_storable';
    END IF;
    IF p_end_reason = ANY (v_secondary)
       OR pg_catalog.cardinality(v_secondary) <> (SELECT pg_catalog.count(DISTINCT s) FROM pg_catalog.unnest(v_secondary) s) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSIF p_end_reason IS NOT NULL OR pg_catalog.cardinality(v_secondary) > 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  -- Round 18: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (round 9), only they.
  IF (p_scheduled_at IS NULL) = coalesce(p_entry_kind IN ('scheduled_entry', 'scheduled_entry_catchup'), false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  -- The signed TL 407 (process-and-lifecycle.md, profiling track; Q191), held until the commit;
  -- the status service checked the guard on the facts read under the same participation lock.
  IF v_track = 'profiling' AND p_to = 'profiling_done' THEN
    SELECT greatest(d.signed_on, d.countersigned_on) INTO v_signed_on
    FROM public.document d
    WHERE d.id IN (SELECT e.document_id FROM public.tl407_evidence(p_id) e)
    ORDER BY 1, d.id LIMIT 1 FOR SHARE;
    IF p_effective_date < v_signed_on THEN
      RAISE EXCEPTION 'effective_date_before_signature';
    END IF;
  END IF;

  IF v_track = 'dsv' AND p_to = 'dsv_offered' AND NOT EXISTS (
    SELECT FROM public.dsv_offer WHERE participation_id = p_id AND ended_as IS NULL
      AND status_event_id IS NULL AND offer_deadline = p_offer_deadline) THEN
    RAISE EXCEPTION 'dsv_offer_missing';
  END IF;
  IF p_to = 'dsv_offered' THEN
    IF r.entry_wave_id IS NULL THEN
      RAISE EXCEPTION 'wave_required';
    END IF;
    -- The first offer may use the wave's deadline, a re-offer needs its own (Q69); the system
    -- never invents one.
    SELECT signing_deadline INTO v_signing_deadline FROM public.project_entry_wave WHERE id = r.entry_wave_id;
    IF p_offer_deadline IS NULL AND (p_expected_from <> 'not_offered' OR v_signing_deadline IS NULL) THEN
      RAISE EXCEPTION 'offer_deadline_required';
    END IF;
  ELSIF p_offer_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  UPDATE public.participation SET
    status = CASE WHEN p_field = 'status' THEN p_to::public.main_status ELSE status END,
    profiling_status = CASE WHEN p_field = 'profiling_status' THEN p_to::public.profiling_status ELSE profiling_status END,
    dsv_status = CASE WHEN p_field = 'dsv_status' THEN p_to::public.dsv_status ELSE dsv_status END,
    tg_entry_date = CASE WHEN p_to = 'active_in_tg' THEN p_effective_date ELSE tg_entry_date END,
    exit_date = CASE WHEN p_to = 'exited' THEN p_effective_date ELSE exit_date END,
    withdrawn_on = CASE WHEN p_to = 'withdrawn' THEN p_effective_date ELSE withdrawn_on END,
    profiling_done_on = CASE WHEN p_to = 'profiling_done' THEN p_effective_date ELSE profiling_done_on END,
    end_reason = CASE WHEN v_ending THEN p_end_reason ELSE end_reason END,
    end_reason_source = CASE WHEN v_ending THEN (p_context).actor_type ELSE end_reason_source END,
    end_reason_secondary = CASE WHEN v_ending THEN v_secondary ELSE end_reason_secondary END,
    offer_deadline = CASE WHEN p_to = 'dsv_offered' THEN p_offer_deadline ELSE offer_deadline END,
    status_version = status_version + 1
  WHERE id = p_id
  RETURNING * INTO r;

  v_event := public.write_audit_event(r.project_id, p_id, 'status_changed', p_context, p_field,
    p_expected_from, p_to, p_end_reason::text, p_effective_date,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entryKind', p_entry_kind,
      'scheduledAt', pg_catalog.to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'secondaryReasons', CASE WHEN pg_catalog.cardinality(v_secondary) > 0 THEN pg_catalog.to_jsonb(v_secondary) END,
      'offerDeadline', p_offer_deadline,
      'offerOrigin', CASE WHEN p_to = 'dsv_offered' THEN (SELECT origin FROM public.dsv_offer
        WHERE participation_id = p_id AND ended_as IS NULL) END)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies (round 10; system-only, round 12), as
  -- system with the same correlation ids (round 16).
  IF v_request.status IS NOT DISTINCT FROM 'requested' THEN
    v_stale := CASE
      WHEN r.status IN ('withdrawn', 'ta_completed', 'exited') THEN 'participation_closed'
      WHEN r.profiling_status IN ('profiling_done', 'profiling_declined') THEN 'profiling_closed'
    END;
    IF v_stale IS NOT NULL THEN
      UPDATE public.profiling_exception_request
      SET status = 'superseded', superseded_reason = v_stale
      WHERE id = v_request.id;
      PERFORM public.write_audit_event(r.project_id, p_id, 'profiling_exception_superseded',
        ROW('system', NULL, NULL, 'lifecycle.supersede-stale-exception', NULL,
            (p_context).request_id, (p_context).job_id)::public.audit_context,
        NULL, NULL, NULL, v_stale::text, NULL,
        pg_catalog.jsonb_build_object('profilingExceptionRequestId', v_request.id, 'statusChangeId', v_event), false);
    END IF;
  END IF;
  IF v_track = 'dsv' AND p_expected_from = 'dsv_offered'
     AND p_to IN ('dsv_signed', 'dsv_declined', 'dsv_expired') THEN
    UPDATE public.dsv_offer SET ended_as = CASE p_to WHEN 'dsv_signed' THEN 'signed'
      WHEN 'dsv_declined' THEN 'declined' ELSE 'expired' END, ended_at = now()
    WHERE participation_id = p_id AND ended_as IS NULL;
  END IF;
  RETURN v_event;
END $$;

--> statement-breakpoint
CREATE FUNCTION offer_dsv(p_context audit_context, p_participation_id uuid,
  p_generation_id uuid, p_external jsonb, p_expected_status_version integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  g public.form_generation;
  w public.project_entry_wave;
  v_id uuid := gen_random_uuid();
  v_event uuid;
  v_deadline date;
  v_start date;
  v_end date;
  v_version text;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL OR NOT public.document_staff_roles(r.id,
      (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version IS DISTINCT FROM p_expected_status_version THEN RAISE EXCEPTION 'stale_status'; END IF;
  IF r.status <> 'informed' OR (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'track_inactive';
  END IF;
  IF r.dsv_status NOT IN ('not_offered', 'dsv_declined', 'dsv_expired') THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF (p_generation_id IS NULL) = (p_external IS NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wave_required'; END IF;
  v_start := coalesce(r.tg_start, w.default_tg_start);
  v_end := coalesce(r.tg_end, w.default_tg_end);
  IF p_generation_id IS NOT NULL THEN
    SELECT * INTO g FROM public.form_generation WHERE id = p_generation_id
      AND participation_id = r.id AND form_code::text = 'dsv' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'generation_not_found'; END IF;
    IF NOT public.dsv_generation_current(g.id, g.organisation_sha256)
       OR EXISTS (SELECT FROM public.dsv_offer WHERE participation_id = r.id AND ended_at >= g.generated_at)
       OR EXISTS (SELECT FROM public.document WHERE id = g.document_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    v_deadline := g.offer_deadline;
    v_version := g.form_version;
  ELSE
    v_deadline := (p_external->>'deadline')::date;
    IF (p_external->>'printedTgStart')::date IS DISTINCT FROM v_start
       OR (p_external->>'printedTgEnd')::date IS DISTINCT FROM v_end THEN
      RAISE EXCEPTION 'terms_mismatch';
    END IF;
    v_version := 'external_unknown';
  END IF;
  IF v_deadline IS NULL OR v_start IS NULL OR v_end IS NULL OR w.latest_entry_date IS NULL
     OR v_deadline < (now() AT TIME ZONE 'Europe/Berlin')::date
     OR v_deadline > v_start OR v_deadline > w.latest_entry_date THEN
    RAISE EXCEPTION 'offer_deadline_invalid';
  END IF;
  INSERT INTO public.dsv_offer(id, project_id, participation_id, generation_id, origin,
    template_version, offer_deadline, printed_tg_start, printed_tg_end, offered_by)
  VALUES(v_id, r.project_id, r.id, p_generation_id,
    CASE WHEN p_generation_id IS NULL THEN 'external_paper' ELSE 'generated' END,
    v_version, v_deadline, v_start, v_end, (p_context).staff_user_id);
  v_event := public.apply_status_change(r.id, 'dsv_status', r.dsv_status::text,
    'dsv_offered', p_context, p_offer_deadline => v_deadline);
  UPDATE public.dsv_offer SET status_event_id = v_event WHERE id = v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION decline_dsv_offer(p_context audit_context, p_participation_id uuid,
  p_offer_id uuid, p_expected_status_version integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL OR NOT public.document_staff_roles(r.id,
    (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.dsv_offer WHERE id = p_offer_id AND participation_id = r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF r.status_version IS DISTINCT FROM p_expected_status_version OR NOT EXISTS (
    SELECT FROM public.dsv_offer WHERE id = p_offer_id AND ended_as IS NULL) THEN
    RAISE EXCEPTION 'stale_status';
  END IF;
  RETURN public.apply_status_change(r.id, 'dsv_status', 'dsv_offered', 'dsv_declined', p_context);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION offer_dsv, decline_dsv_offer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION offer_dsv, decline_dsv_offer TO transfer_app;
