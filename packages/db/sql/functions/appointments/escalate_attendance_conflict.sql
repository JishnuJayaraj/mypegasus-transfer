CREATE OR REPLACE FUNCTION public.escalate_attendance_conflict(p_context public.audit_context, p_booking_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE b public.appointment_booking := public.lock_conflict_booking(p_context, p_booking_id);
BEGIN
  IF b.conflict_escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_escalated';
  END IF;
  UPDATE public.appointment_booking SET conflict_escalated_by = (p_context).staff_user_id,
    conflict_escalated_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(b.project_id, b.participation_id,
    'attendance_conflict_escalated', p_context, NULL, NULL, NULL, NULL, NULL,
    public.booking_event_details(b, (SELECT x FROM public.appointment x WHERE x.id = b.appointment_id)),
    false);
END $function$;

ALTER FUNCTION public.escalate_attendance_conflict(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.escalate_attendance_conflict(public.audit_context,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.escalate_attendance_conflict(public.audit_context,uuid) TO transfer_app;
