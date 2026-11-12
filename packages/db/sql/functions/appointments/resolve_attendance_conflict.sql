CREATE OR REPLACE FUNCTION public.resolve_attendance_conflict(p_context public.audit_context, p_booking_id uuid, p_resolution public.attendance_conflict_resolution)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE b public.appointment_booking;
BEGIN
  IF p_resolution IS DISTINCT FROM 'information_delivered_otherwise' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_conflict_booking(p_context, p_booking_id);
  UPDATE public.appointment_booking SET conflict_resolution = p_resolution,
    conflict_resolved_by = (p_context).staff_user_id, conflict_resolved_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'attendance_conflict_resolved', p_context, NULL, NULL, NULL, p_resolution::text, NULL,
    public.booking_event_details(b, (SELECT x FROM public.appointment x WHERE x.id = b.appointment_id)),
    false);
END $function$;

ALTER FUNCTION public.resolve_attendance_conflict(public.audit_context,uuid,public.attendance_conflict_resolution) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.resolve_attendance_conflict(public.audit_context,uuid,public.attendance_conflict_resolution) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_conflict(public.audit_context,uuid,public.attendance_conflict_resolution) TO transfer_app;
