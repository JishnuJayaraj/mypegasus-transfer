CREATE OR REPLACE FUNCTION public.field_correction_problem(r public.participation, p_field_key text, p_corrected_on date, OUT original date, OUT problem text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text;
  v_bound date;
BEGIN
  IF p_field_key = 'profilingDoneOn' THEN
    original := CASE WHEN r.profiling_status::text = 'profiling_done' THEN r.profiling_done_on END;
  ELSE
    original := CASE WHEN r.status::text = 'withdrawn' THEN r.withdrawn_on END;
  END IF;
  IF original IS NULL THEN
    problem := 'field_not_recorded';
    RETURN;
  END IF;
  IF p_field_key = 'withdrawnOn' THEN
    SELECT f.actor_type INTO v_actor FROM public.field_status_change(r.id, 'withdrawnOn') f;
    IF v_actor IS DISTINCT FROM 'user' THEN
      problem := 'withdrawal_by_system';
      RETURN;
    END IF;
  END IF;
  IF p_corrected_on = original THEN
    problem := 'correction_unchanged';
  ELSIF p_corrected_on > public.berlin_today() THEN
    problem := 'corrected_on_in_future';
  ELSIF p_field_key = 'profilingDoneOn' THEN
    SELECT pg_catalog.min(greatest(d.signed_on, d.countersigned_on)) INTO v_bound
    FROM public.document d
    WHERE d.participation_id = r.id AND d.type = 'tl407_signed_scan'
      AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
      AND d.invalidated_by_correction IS NULL;
    IF v_bound IS NULL OR p_corrected_on < v_bound THEN
      problem := 'effective_date_before_signature';
    END IF;
  ELSIF r.dsv_status::text = 'dsv_signed' THEN
    SELECT pg_catalog.min(f.valid_on) INTO v_bound
    FROM public.dsv_cancellation_facts(ARRAY[r.id]) f;
    IF v_bound IS NULL OR p_corrected_on < v_bound THEN
      problem := 'effective_date_before_cancellation';
    END IF;
  END IF;
END $function$;

ALTER FUNCTION public.field_correction_problem(public.participation,text,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.field_correction_problem(public.participation,text,date) FROM PUBLIC;
