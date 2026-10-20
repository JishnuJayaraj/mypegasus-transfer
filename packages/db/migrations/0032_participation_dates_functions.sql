-- Hand-written (Slice 2 plan 5.2, 5.3 and 5.7; rounds 32–34; PR 2h-3): individual TG dates with
-- their DSV amendment and BA reporting tasks, the early-exit task, immutability, and the grants.
-- Same hardening as 0004 and 0011: SECURITY DEFINER owned by transfer_owner, a fixed search_path
-- with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app,
-- refusals as P0001 with a stable code, never a value. The rules are the domain's
-- (`checkParticipationDates`); the function holds the integrity they rest on.

-- An amendment is never changed or removed (R41), whoever writes.
CREATE TRIGGER participation_dsv_amendment_append_only BEFORE UPDATE OR DELETE
  ON public.participation_dsv_amendment
  FOR EACH ROW EXECUTE FUNCTION public.refuse_config_change();
--> statement-breakpoint

-- A BA reporting task is never removed, and only its status moves, forward only: from `pending`
-- to `reported` or `not_required` (R42). What it reports never changes.
CREATE FUNCTION ba_reporting_task_progresses()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  IF (NEW.id, NEW.participation_id, NEW.project_id, NEW.reporting_kind, NEW.subject_date,
      NEW.amendment_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.participation_id, OLD.project_id, OLD.reporting_kind, OLD.subject_date,
      OLD.amendment_id, OLD.created_at)
     OR OLD.status <> 'pending' OR NEW.status NOT IN ('reported', 'not_required') THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ba_reporting_task_progresses BEFORE UPDATE OR DELETE ON public.ba_reporting_task
  FOR EACH ROW EXECUTE FUNCTION public.ba_reporting_task_progresses();
--> statement-breakpoint

-- An exit before the effective contractual end, or without one, is a vorzeitiger Austritt to
-- report (round 32 B3, R38, R39: `exit_date` is the last day of employment). Written in the exit's
-- own transaction, so no caller can skip it; the status changes only through the status function,
-- which runs as the owner, so the trigger does too.
CREATE FUNCTION create_early_exit_task()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_end date := coalesce(NEW.tg_end,
    (SELECT default_tg_end FROM public.project_entry_wave WHERE id = NEW.entry_wave_id));
BEGIN
  IF v_end IS NULL OR NEW.exit_date < v_end THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date)
    VALUES (NEW.id, NEW.project_id, 'early_exit', NEW.exit_date);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER participation_early_exit_task AFTER UPDATE OF status ON public.participation
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'exited')
  EXECUTE FUNCTION public.create_early_exit_task();
--> statement-breakpoint

-- The PL's change of the contractual dates (5.3, 5.7; round 33): typed parameters only, the
-- amendment ones all set or all null. In this one call: the compare-and-set of the dates, the
-- immutable amendment of a signed DSV, one BA reporting task per changed effective date and the
-- audit event; any refusal raises, so all of it commits or none.
CREATE FUNCTION set_participation_dates(
  p_id uuid, p_tg_start date, p_tg_end date, p_expected_version integer, p_context audit_context,
  p_amendment_kind dsv_amendment_kind DEFAULT NULL, p_amendment_fully_executed_on date DEFAULT NULL,
  p_amendment_original_location amendment_original_location DEFAULT NULL,
  p_amendment_document_reference text DEFAULT NULL, p_amendment_confirmed boolean DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  w public.project_entry_wave;
  v_old_start date;
  v_new_start date;
  v_old_end date;
  v_new_end date;
  v_start_changed boolean;
  v_end_changed boolean;
  v_kind public.dsv_amendment_kind;
  v_amendment_id uuid;
  v_kinds text[] := '{}';
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_expected_version IS NULL
     OR num_nulls(p_amendment_kind, p_amendment_fully_executed_on, p_amendment_original_location,
       p_amendment_confirmed) NOT IN (0, 4)
     OR p_amendment_confirmed IS FALSE
     OR (p_amendment_kind IS NULL AND p_amendment_document_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- The shared project lock, then the row (D3): a wave edit never interleaves.
  r := public.lock_participation(p_id);
  IF r.status_version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_status';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wave_required';
  END IF;
  IF r.status IN ('withdrawn', 'rejected', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF r.dsv_status = 'dsv_offered' THEN
    RAISE EXCEPTION 'dsv_offer_open';
  END IF;
  -- An amendment exactly once the DSV is signed (R34, round 33).
  IF r.dsv_status = 'dsv_signed' AND p_amendment_kind IS NULL THEN
    RAISE EXCEPTION 'dsv_amendment_required';
  END IF;
  IF r.dsv_status <> 'dsv_signed' AND p_amendment_kind IS NOT NULL THEN
    RAISE EXCEPTION 'amendment_not_allowed';
  END IF;
  v_old_start := coalesce(r.tg_start, w.default_tg_start);
  v_new_start := coalesce(p_tg_start, w.default_tg_start);
  v_old_end := coalesce(r.tg_end, w.default_tg_end);
  v_new_end := coalesce(p_tg_end, w.default_tg_end);
  v_start_changed := v_old_start IS DISTINCT FROM v_new_start;
  v_end_changed := v_old_end IS DISTINCT FROM v_new_end;
  IF NOT v_start_changed AND NOT v_end_changed THEN
    RAISE EXCEPTION 'dates_unchanged';
  END IF;
  IF v_start_changed AND r.status = 'active_in_tg' THEN
    RAISE EXCEPTION 'entered';
  END IF;
  -- A new start's amendment when the start changes, else an extension's (R41).
  v_kind := CASE WHEN r.dsv_status <> 'dsv_signed' THEN NULL
    WHEN v_start_changed THEN 'new_start' ELSE 'extension' END;
  IF p_amendment_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'amendment_kind_mismatch';
  END IF;

  UPDATE public.participation
  SET tg_start = p_tg_start, tg_end = p_tg_end, status_version = status_version + 1
  WHERE id = p_id;
  IF p_amendment_kind IS NOT NULL THEN
    INSERT INTO public.participation_dsv_amendment (
      participation_id, project_id, kind, fully_executed_on, old_tg_start, new_tg_start, old_tg_end,
      new_tg_end, confirmed_by, original_location, document_reference
    ) VALUES (
      p_id, r.project_id, p_amendment_kind, p_amendment_fully_executed_on, v_old_start, v_new_start,
      v_old_end, v_new_end, (p_context).staff_user_id, p_amendment_original_location,
      p_amendment_document_reference
    ) RETURNING id INTO v_amendment_id;
  END IF;
  IF v_start_changed THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date, amendment_id)
    VALUES (p_id, r.project_id, 'later_entry', v_new_start, v_amendment_id);
    v_kinds := array_append(v_kinds, 'later_entry');
  END IF;
  IF v_end_changed THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date, amendment_id)
    VALUES (p_id, r.project_id, 'planned_end_changed', v_new_end, v_amendment_id);
    v_kinds := array_append(v_kinds, 'planned_end_changed');
  END IF;
  RETURN public.write_audit_event(r.project_id, p_id, 'participation_dates_changed', p_context, NULL,
    NULL, NULL, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'oldTgStart', CASE WHEN v_start_changed THEN v_old_start END,
      'newTgStart', CASE WHEN v_start_changed THEN v_new_start END,
      'oldTgEnd', CASE WHEN v_end_changed THEN v_old_end END,
      'newTgEnd', CASE WHEN v_end_changed THEN v_new_end END,
      'amendmentId', v_amendment_id,
      'reportingKinds', to_jsonb(v_kinds))), false);
END $$;
--> statement-breakpoint

-- The date change's event is written only by its function (AC-40).
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
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn',
      'project_activated', 'participant_data_changed', 'participation_dates_changed') THEN
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

REVOKE ALL ON FUNCTION ba_reporting_task_progresses, create_early_exit_task, set_participation_dates
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_participation_dates TO transfer_app;
--> statement-breakpoint
-- transfer_app reads them (the detail page); every write is the function's or the trigger's.
GRANT SELECT ON TABLE participation_dsv_amendment, ba_reporting_task TO transfer_app;
