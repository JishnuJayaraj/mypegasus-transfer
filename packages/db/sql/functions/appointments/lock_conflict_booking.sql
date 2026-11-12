CREATE OR REPLACE FUNCTION public.lock_conflict_booking(p_context public.audit_context, p_booking_id uuid)
 RETURNS public.appointment_booking
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation uuid;
  b public.appointment_booking;
BEGIN
  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.appointment_booking
  WHERE id = p_booking_id;
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  PERFORM public.lock_participation(v_participation);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(v_participation,
       (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.appointment x WHERE x.id = (
    SELECT appointment_id FROM public.appointment_booking WHERE id = p_booking_id) FOR SHARE;
  SELECT * INTO b FROM public.appointment_booking WHERE id = p_booking_id FOR UPDATE;
  IF NOT public.booking_conflict_open(b) THEN
    RAISE EXCEPTION 'no_conflict';
  END IF;
  RETURN b;
END $function$;

ALTER FUNCTION public.lock_conflict_booking(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_conflict_booking(public.audit_context,uuid) FROM PUBLIC;
