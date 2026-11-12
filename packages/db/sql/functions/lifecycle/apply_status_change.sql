CREATE OR REPLACE FUNCTION public.apply_status_change(p_id uuid, p_field public.status_field, p_expected_from text, p_to text, p_context public.audit_context, p_entry_kind public.tg_entry_kind DEFAULT NULL::public.tg_entry_kind, p_end_reason public.end_reason DEFAULT NULL::public.end_reason, p_secondary_reasons public.end_reason[] DEFAULT '{}'::public.end_reason[], p_offer_deadline date DEFAULT NULL::date, p_effective_date date DEFAULT NULL::date, p_scheduled_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_activation boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  v_offer uuid;
  v_tg_start date;
  v_cancellation record;
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system,participant}');
  IF p_field IS NULL OR p_to IS NULL OR p_activation IS NULL
     OR p_activation AND p_entry_kind IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (process-and-lifecycle.md, project activation): no transition of a draft project, manual or system. The shared
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

  -- Track activity (process-and-lifecycle.md, lifecycle tracks): the tracks move while `informed` (DSV only in ta_tg); in the TG
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

  -- process-and-lifecycle.md: a date for every dependent column and for DSV expiry (deadline + 1), and none where
  -- it means nothing. Its value is bounded by the status service.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (process-and-lifecycle.md, TG entry), only they.
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
  IF p_field = 'dsv_status' AND p_to = 'dsv_signed' AND NOT EXISTS (
    SELECT FROM public.dsv_facts(ARRAY[p_id]) f JOIN public.dsv_offer o ON o.id = f.offer_id WHERE o.ended_as IS NULL
  ) THEN RAISE EXCEPTION 'dsv_scan_missing'; END IF;
  -- The TG entry rests on the complete packet (process-and-lifecycle.md, TG entry guard): one counting
  -- scan of the signed offer with the three signatures, valid by the entry date and, for an automatic
  -- entry, recorded before the run's snapshot. Documentary and contractual: no override.
  IF p_field = 'status' AND p_to = 'active_in_tg' AND NOT (
    r.dsv_status = 'dsv_signed' AND p_effective_date IS NOT NULL AND EXISTS (
      SELECT FROM public.dsv_facts(ARRAY[p_id]) f JOIN public.dsv_offer o ON o.id = f.offer_id
      WHERE o.ended_as = 'signed' AND f.executed_on <= p_effective_date
        AND (p_scheduled_at IS NULL OR f.recorded_at <= p_scheduled_at))
  ) THEN RAISE EXCEPTION 'dsv_packet_missing'; END IF;
  -- A reconciliation (process-and-lifecycle.md, the reconciliation; Q68 case 2, Q80) comes with its
  -- review row, written just before by `reconcile_tg_entry` in the same transaction for the same
  -- effective date: never a reconciled entry without its review, whoever calls the status function.
  IF p_entry_kind IS NOT DISTINCT FROM 'reconciliation' AND NOT EXISTS (
    SELECT FROM public.tg_entry_reconciliation t WHERE t.participation_id = p_id
      AND t.status_event_id IS NULL AND t.effective_date = p_effective_date) THEN
    RAISE EXCEPTION 'reconciliation_missing';
  END IF;
  -- A signed DSV is withdrawn only on its cancellation (process-and-lifecycle.md, the cancellation;
  -- Q46 verify, Q213): by a user (the system never withdraws a signed DSV), on or before the
  -- effective TG start (after it, the entry clarification), dated not before the counting
  -- cancellation's validity, which is held until the commit. Contractual: no override (Q71). The
  -- PL's confirmation is the status service's (the guard `withdrawal_after_dsv_signed`).
  IF p_field = 'status' AND p_to = 'withdrawn' AND r.dsv_status = 'dsv_signed' THEN
    IF (p_context).actor_type <> 'user' THEN RAISE EXCEPTION 'withdrawal_after_dsv_signed'; END IF;
    SELECT coalesce(r.tg_start, w.default_tg_start) INTO v_tg_start
    FROM (SELECT 1) x LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id;
    IF v_tg_start IS NULL THEN RAISE EXCEPTION 'tg_start_missing'; END IF;
    IF public.berlin_today() > v_tg_start THEN RAISE EXCEPTION 'after_planned_start'; END IF;
    SELECT f.document_id, f.valid_on INTO v_cancellation
    FROM public.dsv_cancellation_facts(ARRAY[p_id]) f
    ORDER BY f.recorded_at, f.document_id LIMIT 1;
    IF v_cancellation.document_id IS NULL OR v_cancellation.valid_on > public.berlin_today() THEN
      RAISE EXCEPTION 'dsv_cancellation_missing';
    END IF;
    PERFORM FROM public.document WHERE id = v_cancellation.document_id FOR SHARE;
    IF p_effective_date < v_cancellation.valid_on THEN
      RAISE EXCEPTION 'effective_date_before_cancellation';
    END IF;
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

  -- Supersede a pending request that no longer applies, as system with the same correlation ids
  -- (process-and-lifecycle.md, profiling exceptions).
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
    WHERE participation_id = p_id AND ended_as IS NULL
    RETURNING id INTO v_offer;
    IF p_to = 'dsv_signed' THEN
      PERFORM public.sync_dsv_contract(v_offer);
    END IF;
  END IF;
  IF p_field = 'status' AND p_to = 'active_in_tg' THEN
    PERFORM public.sync_dsv_contract(o.id) FROM public.dsv_offer o
    WHERE o.participation_id = p_id AND o.ended_as = 'signed';
  END IF;
  RETURN v_event;
END $function$;

ALTER FUNCTION public.apply_status_change(uuid,public.status_field,text,text,public.audit_context,public.tg_entry_kind,public.end_reason,public.end_reason[],date,date,timestamp with time zone,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.apply_status_change(uuid,public.status_field,text,text,public.audit_context,public.tg_entry_kind,public.end_reason,public.end_reason[],date,date,timestamp with time zone,boolean) FROM PUBLIC;
