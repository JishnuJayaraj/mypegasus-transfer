CREATE OR REPLACE FUNCTION public.cancel_appointment_booking(p_context public.audit_context, p_booking_id uuid, p_token_hash text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participant boolean := (p_context).actor_type = 'participant';
  v_participation uuid;
  v_appointment uuid;
  s public.participant_session;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL OR coalesce(v_participant, false) = (p_token_hash IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, appointment_id INTO v_participation, v_appointment
  FROM public.appointment_booking WHERE id = p_booking_id;
  IF v_participant THEN
    PERFORM public.assert_context(p_context, (p_context).participation_id, '{participant}');
    IF v_participation IS DISTINCT FROM (p_context).participation_id THEN
      RAISE EXCEPTION 'booking_not_found';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> v_participation THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  ELSE
    IF v_participation IS NULL THEN
      RAISE EXCEPTION 'booking_not_found';
    END IF;
    PERFORM public.assert_appointment_context(p_context, v_participation);
    p := public.lock_participation(v_participation);
    IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = v_appointment FOR UPDATE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'booking_cancelled';
  END IF;
  IF b.attendance IS NOT NULL THEN
    RAISE EXCEPTION 'attendance_recorded';
  END IF;
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  IF v_participant THEN
    PERFORM public.cancel_booking_row(b, a, 'participant_cancelled', p_context);
  ELSE
    PERFORM public.cancel_booking_row(b, a, 'staff_cancelled', p_context);
    PERFORM public.queue_appointment_notice(b, a, 'appointment_cancelled', gen_random_uuid(),
      p_context);
  END IF;
END $function$;

ALTER FUNCTION public.cancel_appointment_booking(public.audit_context,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.cancel_appointment_booking(public.audit_context,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_appointment_booking(public.audit_context,uuid,text) TO transfer_app;
