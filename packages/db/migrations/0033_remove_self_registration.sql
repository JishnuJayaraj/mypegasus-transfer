-- Hand-written (process-and-lifecycle.md, Main status): `self_registered`, `rejected` and the
-- anonymous self-registration edge kind leave the lifecycle core. Postgres can't drop an enum value, so both
-- types are recreated: every object that names them (the columns, the CHECKs, the early-exit
-- trigger, `end_reason_fits`) is dropped and recreated unchanged in behaviour, and the functions
-- that compared a status with 'rejected' are replaced with the same signatures. Refuses to run on a
-- database that holds a removed value; nothing could ever create one (no anonymous path exists).
DO $$
BEGIN
  IF EXISTS (SELECT FROM public.participation WHERE status::text IN ('self_registered', 'rejected'))
     OR EXISTS (SELECT FROM public.audit_event WHERE field = 'status'
                AND (from_value IN ('self_registered', 'rejected') OR to_value IN ('self_registered', 'rejected'))) THEN
    RAISE EXCEPTION 'self_registration_data_present';
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM public.lifecycle_edge
WHERE kind::text = 'anonymous_self_registration'
   OR track = 'main' AND (from_value IN ('self_registered', 'rejected') OR to_value IN ('self_registered', 'rejected'));
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_unmatched_has_no_wave";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_tracks_start_at_informed";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_end_reason_when_ended";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_withdrawn_on_when_withdrawn";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_tg_entry_date_in_tg";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_exit_date_when_exited";
--> statement-breakpoint
ALTER TABLE "participation" DROP CONSTRAINT "participation_tg_needs_signed_dsv";
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_values_of_field";
--> statement-breakpoint
ALTER TABLE "lifecycle_edge" DROP CONSTRAINT "lifecycle_edge_values_of_track";
--> statement-breakpoint
DROP TRIGGER participation_early_exit_task ON public.participation;
--> statement-breakpoint
DROP FUNCTION end_reason_fits(main_status, end_reason);
--> statement-breakpoint
ALTER TABLE "lifecycle_edge" ALTER COLUMN "kind" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."edge_kind";
--> statement-breakpoint
CREATE TYPE "public"."edge_kind" AS ENUM('scheduled_entry', 'scheduled_entry_catchup', 'reconciliation', 'manual', 'system');
--> statement-breakpoint
ALTER TABLE "lifecycle_edge" ALTER COLUMN "kind" SET DATA TYPE "public"."edge_kind" USING "kind"::"public"."edge_kind";
--> statement-breakpoint
ALTER TABLE "participation" ALTER COLUMN "status" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."main_status";
--> statement-breakpoint
CREATE TYPE "public"."main_status" AS ENUM('imported', 'contacted', 'unreachable', 'informed', 'active_in_tg', 'withdrawn', 'ta_completed', 'exited');
--> statement-breakpoint
ALTER TABLE "participation" ALTER COLUMN "status" SET DATA TYPE "public"."main_status" USING "status"::"public"."main_status";
--> statement-breakpoint
CREATE FUNCTION end_reason_fits(p_status main_status, p_reason end_reason)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_status
    WHEN 'withdrawn' THEN p_reason = ANY ('{declined_profiling,declined_dsv,no_response,never_contacted,not_informed,placed_direct,self_employed,retirement,other_measure,deceased,other}'::public.end_reason[])
    WHEN 'exited' THEN p_reason = ANY ('{placed_permanent,placed_fixed_term,self_employed,retirement,apprenticeship_or_study,max_duration_reached,own_termination_without_job,terminated_by_tg,long_term_illness_reduced_earning_capacity,deceased,other}'::public.end_reason[])
    ELSE false
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION end_reason_fits FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_tracks_start_at_informed" CHECK (not ("participation"."status" in ('imported', 'contacted', 'unreachable')) or ("participation"."profiling_status" = 'not_started' and "participation"."dsv_status" = 'not_offered'));
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_end_reason_when_ended" CHECK ((status = ANY (ARRAY['withdrawn'::main_status, 'exited'::main_status])) = (end_reason IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_withdrawn_on_when_withdrawn" CHECK ((status = 'withdrawn'::main_status) = (withdrawn_on IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_tg_entry_date_in_tg" CHECK ((status = ANY (ARRAY['active_in_tg'::main_status, 'exited'::main_status])) = (tg_entry_date IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_exit_date_when_exited" CHECK ((status = 'exited'::main_status) = (exit_date IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_tg_needs_signed_dsv" CHECK ((NOT (status = ANY (ARRAY['active_in_tg'::main_status, 'exited'::main_status]))) OR (dsv_status = 'dsv_signed'::dsv_status));
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_values_of_field" CHECK ((field IS NULL) OR
CASE field
    WHEN 'status'::status_field THEN ((to_value = ANY ((enum_range(NULL::main_status))::text[])) AND ((from_value IS NULL) OR (from_value = ANY ((enum_range(NULL::main_status))::text[]))))
    WHEN 'profiling_status'::status_field THEN ((to_value = ANY ((enum_range(NULL::profiling_status))::text[])) AND (from_value = ANY ((enum_range(NULL::profiling_status))::text[])))
    ELSE ((to_value = ANY ((enum_range(NULL::dsv_status))::text[])) AND (from_value = ANY ((enum_range(NULL::dsv_status))::text[])))
END);
--> statement-breakpoint
ALTER TABLE "lifecycle_edge" ADD CONSTRAINT "lifecycle_edge_values_of_track" CHECK (((track = 'main'::lifecycle_track) AND (to_value = ANY ((enum_range(NULL::main_status))::text[])) AND ((from_value IS NULL) OR (from_value = ANY ((enum_range(NULL::main_status))::text[])))) OR ((track = 'profiling'::lifecycle_track) AND (to_value = ANY ((enum_range(NULL::profiling_status))::text[])) AND ((from_value IS NULL) OR (from_value = ANY ((enum_range(NULL::profiling_status))::text[])))) OR ((track = 'dsv'::lifecycle_track) AND (to_value = ANY ((enum_range(NULL::dsv_status))::text[])) AND ((from_value IS NULL) OR (from_value = ANY ((enum_range(NULL::dsv_status))::text[])))));
--> statement-breakpoint
CREATE TRIGGER participation_early_exit_task AFTER UPDATE OF status ON public.participation
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'exited')
EXECUTE FUNCTION public.create_early_exit_task();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION change_participation_status(
  p_id uuid, p_field status_field, p_expected_from text, p_to text, p_context audit_context,
  p_entry_kind tg_entry_kind DEFAULT NULL, p_end_reason end_reason DEFAULT NULL,
  p_secondary_reasons end_reason[] DEFAULT '{}', p_offer_deadline date DEFAULT NULL,
  p_effective_date date DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system}');
  IF p_field IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  -- The draft gate (process-and-lifecycle.md, Dates): no transition of a draft project, manual or
  -- system. The shared project lock taken above serialises this with activate_project.
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
      AND (CASE WHEN p_entry_kind IS NULL THEN e.kind IN ('manual', 'system') ELSE e.kind::text = p_entry_kind::text END)
  ) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  -- Track activity (process-and-lifecycle.md, Lifecycle model): the tracks move while `informed`
  -- (DSV only in ta_tg); in the TG with an approved exception, profiling moves forward or is
  -- declined (Q74).
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

  -- Effective dates (process-and-lifecycle.md, Rules): a date for every dependent column and for
  -- DSV expiry (deadline + 1), and none where it means nothing. The status service bounds it.
  IF p_to IN ('active_in_tg', 'exited', 'withdrawn', 'profiling_done', 'dsv_expired') THEN
    IF p_effective_date IS NULL THEN
      RAISE EXCEPTION 'effective_date_required';
    END IF;
  ELSIF p_effective_date IS NOT NULL THEN
    RAISE EXCEPTION 'effective_date_not_allowed';
  END IF;
  -- The automatic entry kinds record the run time of their snapshot (process-and-lifecycle.md,
  -- TG entry guard), only they.
  IF (p_scheduled_at IS NULL) = coalesce(p_entry_kind IN ('scheduled_entry', 'scheduled_entry_catchup'), false) THEN
    RAISE EXCEPTION 'invalid_argument';
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
      'offerDeadline', p_offer_deadline)),
    p_entry_kind IS NOT DISTINCT FROM 'reconciliation');

  -- Supersede a pending request that no longer applies (process-and-lifecycle.md, Profiling
  -- track), as system with the same correlation ids.
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
  RETURN v_event;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_participation_dates(
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
  -- The shared project lock, then the row (ADR-0002): a wave edit never interleaves.
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
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF r.dsv_status = 'dsv_offered' THEN
    RAISE EXCEPTION 'dsv_offer_open';
  END IF;
  -- An amendment exactly once the DSV is signed (process-and-lifecycle.md, TG start and end).
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
  -- A new start's amendment when the start changes, else an extension's (same section).
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
CREATE OR REPLACE FUNCTION revoke_profiling_exception(p_request_id uuid, p_context audit_context)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_request public.profiling_exception_request;
  r public.participation;
BEGIN
  v_request := public.lock_current_request(p_request_id, p_context);
  SELECT * INTO r FROM public.participation WHERE id = v_request.participation_id;
  IF v_request.status NOT IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'not_revocable';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited')
     OR (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg'
     OR r.profiling_status IN ('profiling_done', 'profiling_declined') THEN
    RAISE EXCEPTION 'no_longer_applicable';
  END IF;
  IF r.status <> 'informed' THEN
    RAISE EXCEPTION 'not_informed';
  END IF;
  UPDATE public.profiling_exception_request SET status = 'revoked' WHERE id = p_request_id;
  UPDATE public.participation SET status_version = status_version + 1 WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id, 'profiling_exception_revoked', p_context, NULL,
    NULL, NULL, NULL, NULL, jsonb_build_object('profilingExceptionRequestId', p_request_id), false);
END $$;
