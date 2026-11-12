CREATE OR REPLACE FUNCTION public.cancel_appointment(p_context public.audit_context, p_id uuid, p_reason public.appointment_cancel_reason)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project uuid;
  a public.appointment;
  b public.appointment_booking;
  v_roles text[];
  v_recorded text[];
  v_correction boolean := false;
  v_count integer := 0;
  v_batch uuid := gen_random_uuid();
BEGIN
  IF p_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  PERFORM public.lock_appointment_participations(p_id);
  SELECT * INTO a FROM public.appointment WHERE id = p_id FOR UPDATE;
  v_roles := public.assert_appointment_manager(v_project, (p_context).staff_user_id, a.kind,
    a.host_staff_user_id);
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  PERFORM FROM public.appointment_booking WHERE appointment_id = p_id AND status = 'booked'
  ORDER BY id FOR UPDATE;
  v_recorded := ARRAY(SELECT attendance::text FROM public.appointment_booking
                      WHERE appointment_id = p_id AND status = 'booked' AND attendance IS NOT NULL);
  IF pg_catalog.cardinality(v_recorded) > 0 THEN
    IF p_reason = 'did_not_take_place' AND 'project_lead' = ANY (v_roles)
       AND 'absent' = ALL (v_recorded) THEN
      v_correction := true;
    ELSE
      RAISE EXCEPTION 'attendance_recorded';
    END IF;
  END IF;
  FOR b IN SELECT * FROM public.appointment_booking
           WHERE appointment_id = p_id AND status = 'booked' ORDER BY id LOOP
    IF b.attendance IS NOT NULL THEN
      PERFORM public.write_audit_event(b.project_id, b.participation_id, 'attendance_superseded',
        p_context, NULL, NULL, NULL, NULL, NULL,
        public.booking_event_details(b, a) || '{"previousAttendance": "absent"}'::jsonb, false);
    END IF;
    PERFORM public.cancel_booking_row(b, a, 'appointment_cancelled', p_context);
    IF b.attendance IS NOT NULL THEN
      UPDATE public.appointment_booking SET attendance_superseded_by = (p_context).staff_user_id,
        attendance_superseded_at = now()
      WHERE id = b.id;
    END IF;
    IF NOT v_correction THEN
      PERFORM public.queue_appointment_notice(b, a, 'appointment_cancelled', v_batch, p_context);
    END IF;
    v_count := v_count + 1;
  END LOOP;
  UPDATE public.appointment SET status = 'cancelled', cancel_reason = p_reason,
    cancelled_at = now(), version = version + 1
  WHERE id = p_id;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_cancelled', p_context, NULL,
    NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('appointmentId', p_id, 'correction', v_correction), false);
  RETURN v_count;
END $function$;

ALTER FUNCTION public.cancel_appointment(public.audit_context,uuid,public.appointment_cancel_reason) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.cancel_appointment(public.audit_context,uuid,public.appointment_cancel_reason) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_appointment(public.audit_context,uuid,public.appointment_cancel_reason) TO transfer_app;
