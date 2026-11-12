CREATE OR REPLACE FUNCTION public.resolve_missed_appointment(p_context public.audit_context, p_booking_id uuid, p_reason public.missed_resolution)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation uuid;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.appointment_booking
  WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT x.* INTO a FROM public.appointment x WHERE x.id = (
    SELECT appointment_id FROM public.appointment_booking WHERE id = p_booking_id) FOR SHARE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF b.missed_resolution IS NOT NULL THEN
    RAISE EXCEPTION 'already_resolved';
  END IF;
  IF NOT public.booking_missed(b) THEN
    RAISE EXCEPTION 'not_missed';
  END IF;
  UPDATE public.appointment_booking SET missed_resolution = p_reason,
    missed_resolved_by = (p_context).staff_user_id, missed_resolved_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'missed_appointment_resolved', p_context, NULL, NULL, NULL, p_reason::text, NULL,
    public.booking_event_details(b, a), false);
END $function$;

ALTER FUNCTION public.resolve_missed_appointment(public.audit_context,uuid,public.missed_resolution) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.resolve_missed_appointment(public.audit_context,uuid,public.missed_resolution) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_missed_appointment(public.audit_context,uuid,public.missed_resolution) TO transfer_app;
