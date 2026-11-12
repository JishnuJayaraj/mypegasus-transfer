CREATE OR REPLACE FUNCTION public.confirm_informed(p public.participation, b public.appointment_booking, a public.appointment, p_context public.audit_context)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_changes integer := 1;
BEGIN
  IF p.status = 'unreachable' AND NOT public.participation_before_cutoff(p) THEN
    RAISE EXCEPTION 'before_cutoff';
  END IF;
  UPDATE public.appointment_booking SET informed_basis_by = (p_context).staff_user_id,
    informed_basis_at = now()
  WHERE id = b.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'information_delivery_confirmed', p_context,
    NULL, NULL, NULL, NULL, NULL,
    public.booking_event_details(b, a) || '{"statusChanged": true}'::jsonb, false);
  IF p.status IN ('imported', 'unreachable') THEN
    PERFORM public.apply_status_change(p.id, 'status', p.status::text, 'contacted', p_context);
    v_changes := 2;
  END IF;
  PERFORM public.apply_status_change(p.id, 'status', 'contacted', 'informed', p_context);
  RETURN v_changes;
END $function$;

ALTER FUNCTION public.confirm_informed(public.participation,public.appointment_booking,public.appointment,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.confirm_informed(public.participation,public.appointment_booking,public.appointment,public.audit_context) FROM PUBLIC;
