CREATE OR REPLACE FUNCTION public.record_attendance(p_context public.audit_context, p_appointment_id uuid, p_participation_ids uuid[], p_attendance public.attendance[], p_mark_informed boolean[], p_information_delivered boolean, p_after_close_reason public.attendance_after_close_reason DEFAULT NULL::public.attendance_after_close_reason)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := pg_catalog.cardinality(p_participation_ids);
  v_project uuid;
  a public.appointment;
  p public.participation;
  b public.appointment_booking;
  v_roles text[];
  v_found boolean;
  v_closed boolean;
  v_attendance public.attendance;
  v_previous public.attendance;
  v_recorded integer := 0;
  v_informed integer := 0;
  v_changes integer := 0;
BEGIN
  IF p_appointment_id IS NULL OR p_information_delivered IS NULL OR v_count IS NULL
     OR v_count NOT BETWEEN 1 AND 500
     OR pg_catalog.cardinality(p_attendance) IS DISTINCT FROM v_count
     OR pg_catalog.cardinality(p_mark_informed) IS DISTINCT FROM v_count
     OR pg_catalog.array_position(p_participation_ids, NULL) IS NOT NULL
     OR pg_catalog.array_position(p_attendance, NULL) IS NOT NULL
     OR pg_catalog.array_position(p_mark_informed, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_participation_ids) x) <> v_count THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  PERFORM FROM public.participation q WHERE q.id = ANY (p_participation_ids)
  ORDER BY q.id FOR UPDATE;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  PERFORM FROM public.appointment_booking bk
  WHERE bk.appointment_id = a.id AND bk.status = 'booked'
    AND bk.participation_id = ANY (p_participation_ids)
  ORDER BY bk.id FOR UPDATE;
  IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF true = ANY (p_mark_informed) AND NOT p_information_delivered THEN
    RAISE EXCEPTION 'information_delivery_unconfirmed';
  END IF;

  FOR i IN 1 .. v_count LOOP
    SELECT * INTO p FROM public.participation
    WHERE id = p_participation_ids[i] AND project_id = v_project;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'participation_not_found';
    END IF;
    v_roles := public.document_staff_roles(p.id, (p_context).staff_user_id);
    IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    v_attendance := p_attendance[i];
    v_closed := p.status IN ('withdrawn', 'ta_completed', 'exited');
    IF v_attendance = 'attended' AND now() < a.starts_at THEN
      RAISE EXCEPTION 'appointment_not_started';
    END IF;
    IF v_attendance = 'absent' AND now() < a.ends_at THEN
      RAISE EXCEPTION 'appointment_not_ended';
    END IF;
    SELECT * INTO b FROM public.appointment_booking
    WHERE appointment_id = a.id AND participation_id = p.id AND status = 'booked';
    v_found := FOUND;
    IF v_closed THEN
      IF NOT 'project_lead' = ANY (v_roles) OR NOT v_found THEN
        RAISE EXCEPTION 'participation_closed';
      END IF;
      IF p_after_close_reason IS NULL THEN
        RAISE EXCEPTION 'after_close_reason_required';
      END IF;
      IF a.starts_at >= coalesce(public.participation_closed_at(p), '-infinity'::timestamptz) THEN
        RAISE EXCEPTION 'started_after_close';
      END IF;
    END IF;
    IF NOT v_found THEN
      IF v_attendance <> 'attended' THEN
        RAISE EXCEPTION 'not_booked';
      END IF;
      IF a.kind = 'consultation' AND NOT public.appointment_staff_allowed(p.id, a.host_staff_user_id) THEN
        RAISE EXCEPTION 'host_not_responsible';
      END IF;
    ELSIF b.attendance IS NOT DISTINCT FROM v_attendance THEN
      RAISE EXCEPTION 'attendance_unchanged';
    END IF;
    IF p_mark_informed[i] AND NOT (v_attendance = 'attended' AND NOT v_closed
         AND (NOT v_found OR b.attendance IS NULL)
         AND p.status IN ('imported', 'contacted', 'unreachable')) THEN
      RAISE EXCEPTION 'mark_informed_not_allowed';
    END IF;

    IF v_found THEN
      v_previous := b.attendance;
      UPDATE public.appointment_booking SET attendance = v_attendance,
        attendance_recorded_by = (p_context).staff_user_id, attendance_recorded_at = now(),
        after_close_reason = CASE WHEN v_closed THEN p_after_close_reason END
      WHERE id = b.id
      RETURNING * INTO b;
    ELSE
      v_previous := NULL;
      INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
        origin, booked_by, attendance, attendance_recorded_by, attendance_recorded_at)
      VALUES (pg_catalog.gen_random_uuid(), v_project, p.id, a.id, 'walk_in',
        (p_context).staff_user_id, v_attendance, (p_context).staff_user_id, now())
      RETURNING * INTO b;
      PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL,
        NULL, NULL, NULL, NULL,
        public.booking_event_details(b, a) || '{"origin": "walk_in"}'::jsonb, false);
    END IF;
    PERFORM public.write_audit_event(v_project, p.id, 'attendance_recorded', p_context, NULL,
      NULL, NULL, CASE WHEN v_closed THEN p_after_close_reason::text END, NULL,
      public.booking_event_details(b, a) || pg_catalog.jsonb_build_object(
        'attendance', v_attendance, 'previousAttendance', v_previous, 'afterClose', v_closed),
      false);
    v_recorded := v_recorded + 1;
    IF p_mark_informed[i] THEN
      v_changes := v_changes + public.confirm_informed(p, b, a, p_context);
      v_informed := v_informed + 1;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('recorded', v_recorded, 'informed', v_informed,
    'statusChanges', v_changes);
END $function$;

ALTER FUNCTION public.record_attendance(public.audit_context,uuid,uuid[],public.attendance[],boolean[],boolean,public.attendance_after_close_reason) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_attendance(public.audit_context,uuid,uuid[],public.attendance[],boolean[],boolean,public.attendance_after_close_reason) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_attendance(public.audit_context,uuid,uuid[],public.attendance[],boolean[],boolean,public.attendance_after_close_reason) TO transfer_app;
