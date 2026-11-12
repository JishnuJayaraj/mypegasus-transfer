CREATE OR REPLACE FUNCTION public.correct_end_reason(p_id uuid, p_new_reason public.end_reason, p_context public.audit_context, p_previous_still_applies boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_secondary public.end_reason[];
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user}');
  IF p_new_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_id);
  IF r.status NOT IN ('withdrawn', 'exited') THEN
    RAISE EXCEPTION 'no_end_reason';
  END IF;
  IF NOT public.end_reason_fits(r.status, p_new_reason) THEN
    RAISE EXCEPTION 'reason_wrong_phase';
  END IF;
  IF p_new_reason = 'long_term_illness_reduced_earning_capacity' THEN
    RAISE EXCEPTION 'reason_not_storable';
  END IF;
  IF p_new_reason = r.end_reason THEN
    RAISE EXCEPTION 'reason_unchanged';
  END IF;
  -- The kept previous reason first, then the existing secondary ones; no duplicates, not the new one.
  SELECT coalesce(array_agg(reason ORDER BY ord), '{}') INTO v_secondary
  FROM (
    SELECT reason, min(ord) AS ord
    FROM unnest(CASE WHEN r.end_reason_source = 'system' OR p_previous_still_applies THEN ARRAY[r.end_reason] ELSE '{}' END
                || r.end_reason_secondary) WITH ORDINALITY AS u(reason, ord)
    WHERE reason <> p_new_reason
    GROUP BY reason
  ) kept;
  UPDATE public.participation SET
    end_reason = p_new_reason, end_reason_source = 'user', end_reason_secondary = v_secondary,
    status_version = status_version + 1
  WHERE id = p_id;
  RETURN public.write_audit_event(r.project_id, p_id, 'end_reason_corrected', p_context, NULL,
    r.end_reason::text, p_new_reason::text, p_new_reason::text, NULL,
    jsonb_build_object('previousSource', r.end_reason_source, 'secondaryReasons', to_jsonb(v_secondary)), false);
END $function$;

ALTER FUNCTION public.correct_end_reason(uuid,public.end_reason,public.audit_context,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.correct_end_reason(uuid,public.end_reason,public.audit_context,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_end_reason(uuid,public.end_reason,public.audit_context,boolean) TO transfer_app;
