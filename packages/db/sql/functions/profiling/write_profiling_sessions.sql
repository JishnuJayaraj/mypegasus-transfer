CREATE OR REPLACE FUNCTION public.write_profiling_sessions(p_participation_id uuid, p_context public.audit_context, p_sessions jsonb, p_revision integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  v_revision integer;
  v_has_record boolean;
  v_changed boolean := false;
  v_session public.profiling_session;
  v_entry jsonb;
  v_id uuid;
BEGIN
  IF p_sessions IS NULL OR NOT public.profiling_sessions_valid(p_sessions)
     OR p_revision IS NULL OR p_revision < 0
     OR (SELECT pg_catalog.count(e ->> 'id') <> pg_catalog.count(DISTINCT e ->> 'id')
         FROM pg_catalog.jsonb_array_elements(p_sessions) e) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
             WHERE e ->> 'from' >= e ->> 'to') THEN
    RAISE EXCEPTION 'session_times_reversed';
  END IF;

  r := public.lock_profiler(p_participation_id, p_context);
  SELECT revision INTO v_revision FROM public.participant_profiling
  WHERE participation_id = r.id FOR UPDATE;
  v_has_record := FOUND;
  v_revision := coalesce(v_revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
             WHERE (e ->> 'date')::date > public.berlin_today()) THEN
    RAISE EXCEPTION 'session_in_future';
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY a(s, i)
    JOIN pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY b(s, i)
      ON a.i < b.i AND a.s ->> 'date' = b.s ->> 'date'
    WHERE a.s ->> 'from' < b.s ->> 'to' AND b.s ->> 'from' < a.s ->> 'to') THEN
    RAISE EXCEPTION 'sessions_overlap';
  END IF;

  PERFORM FROM public.profiling_session WHERE participation_id = r.id ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
    WHERE e ? 'id' AND NOT EXISTS (SELECT FROM public.profiling_session x
                                   WHERE x.id = (e ->> 'id')::uuid AND x.participation_id = r.id))
  THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- Removed: the stored sessions the list doesn't name.
  FOR v_session IN SELECT * FROM public.profiling_session x WHERE x.participation_id = r.id
             AND NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_sessions) e
                             WHERE e ->> 'id' = x.id::text)
           ORDER BY x.session_date, x.time_from, x.id LOOP
    DELETE FROM public.profiling_session WHERE id = v_session.id;
    PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action', 'removed',
        'sessionId', v_session.id, 'date', v_session.session_date), false);
    v_changed := true;
  END LOOP;
  -- Changed and added, in the list's order.
  FOR v_entry IN SELECT x FROM pg_catalog.jsonb_array_elements(p_sessions) WITH ORDINALITY u(x, i)
           ORDER BY i LOOP
    IF v_entry ? 'id' THEN
      v_id := (v_entry ->> 'id')::uuid;
      UPDATE public.profiling_session SET session_date = (v_entry ->> 'date')::date,
        time_from = v_entry ->> 'from', time_to = v_entry ->> 'to',
        recorded_by = (p_context).staff_user_id, recorded_at = pg_catalog.now()
      WHERE id = v_id AND (session_date, time_from, time_to)
        IS DISTINCT FROM ((v_entry ->> 'date')::date, v_entry ->> 'from', v_entry ->> 'to');
      IF FOUND THEN
        PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed',
          p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action',
            'changed', 'sessionId', v_id, 'date', v_entry ->> 'date'), false);
        v_changed := true;
      END IF;
    ELSE
      v_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.profiling_session (id, project_id, participation_id, session_date,
        time_from, time_to, recorded_by)
      VALUES (v_id, r.project_id, r.id, (v_entry ->> 'date')::date, v_entry ->> 'from', v_entry ->> 'to',
        (p_context).staff_user_id);
      PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_session_changed', p_context,
        NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('action', 'added',
          'sessionId', v_id, 'date', v_entry ->> 'date'), false);
      v_changed := true;
    END IF;
  END LOOP;
  IF NOT v_changed THEN
    RETURN v_revision;
  END IF;

  IF v_has_record THEN
    UPDATE public.participant_profiling SET revision = v_revision + 1, updated_at = pg_catalog.now()
    WHERE participation_id = r.id;
  ELSE
    INSERT INTO public.participant_profiling (participation_id, project_id, revision)
    VALUES (r.id, r.project_id, 1);
  END IF;
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_profiling_sessions(uuid,public.audit_context,jsonb,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_profiling_sessions(uuid,public.audit_context,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_profiling_sessions(uuid,public.audit_context,jsonb,integer) TO transfer_app;
