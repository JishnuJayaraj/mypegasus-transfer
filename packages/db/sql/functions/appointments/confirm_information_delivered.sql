CREATE OR REPLACE FUNCTION public.confirm_information_delivered(p_context public.audit_context, p_booking_id uuid, p_information_delivered boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation uuid;
  v_appointment uuid;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
  c public.appointment_booking;
  v_roles text[];
  v_closed boolean;
BEGIN
  IF p_booking_id IS NULL OR p_information_delivered IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, appointment_id INTO v_participation, v_appointment
  FROM public.appointment_booking WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  v_roles := public.document_staff_roles(p.id, (p_context).staff_user_id);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = v_appointment FOR SHARE;
  PERFORM FROM public.appointment_booking WHERE participation_id = p.id ORDER BY id FOR UPDATE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id;
  IF NOT p_information_delivered THEN
    RAISE EXCEPTION 'information_delivery_unconfirmed';
  END IF;
  IF (SELECT status FROM public.project WHERE id = p.project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'booking_cancelled';
  END IF;
  IF b.attendance IS DISTINCT FROM 'attended' THEN
    RAISE EXCEPTION 'not_attended';
  END IF;
  IF b.informed_basis_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_basis';
  END IF;
  IF p.status IN ('imported', 'contacted', 'unreachable') AND b.after_close_reason IS NULL THEN
    RETURN public.confirm_informed(p, b, a, p_context);
  END IF;
  v_closed := p.status IN ('withdrawn', 'ta_completed', 'exited');
  IF EXISTS (SELECT FROM public.appointment_booking x
             WHERE x.participation_id = p.id AND public.booking_conflict_open(x))
     AND (NOT v_closed OR 'project_lead' = ANY (v_roles)) THEN
    UPDATE public.appointment_booking SET informed_basis_by = (p_context).staff_user_id,
      informed_basis_at = now()
    WHERE id = b.id;
    PERFORM public.write_audit_event(p.project_id, p.id, 'information_delivery_confirmed',
      p_context, NULL, NULL, NULL, NULL, NULL,
      public.booking_event_details(b, a) || '{"statusChanged": false}'::jsonb, false);
    FOR c IN SELECT * FROM public.appointment_booking x
             WHERE x.participation_id = p.id AND public.booking_conflict_open(x) ORDER BY x.id LOOP
      UPDATE public.appointment_booking SET conflict_resolution = 'replacement_basis',
        conflict_resolved_by = (p_context).staff_user_id, conflict_resolved_at = now()
      WHERE id = c.id;
      PERFORM public.write_audit_event(p.project_id, p.id, 'attendance_conflict_resolved',
        p_context, NULL, NULL, NULL, 'replacement_basis', NULL,
        public.booking_event_details(c, (SELECT x FROM public.appointment x WHERE x.id = c.appointment_id))
          || pg_catalog.jsonb_build_object('basisBookingId', b.id), false);
    END LOOP;
    RETURN 0;
  END IF;
  RAISE EXCEPTION '%', CASE WHEN v_closed THEN 'participation_closed' ELSE 'already_informed' END;
END $function$;

ALTER FUNCTION public.confirm_information_delivered(public.audit_context,uuid,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.confirm_information_delivered(public.audit_context,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_information_delivered(public.audit_context,uuid,boolean) TO transfer_app;
