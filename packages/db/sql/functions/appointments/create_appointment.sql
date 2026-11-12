CREATE OR REPLACE FUNCTION public.create_appointment(p_context public.audit_context, p_project_id uuid, p_id uuid, p_kind public.appointment_kind, p_host_staff_user_id uuid, p_audience_wave_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_booking_closes_at timestamp with time zone, p_capacity integer, p_title text, p_venue text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_project_id IS NULL OR p_id IS NULL OR p_kind IS NULL
     OR NOT public.appointment_values_valid(p_starts_at, p_ends_at, p_booking_closes_at,
       p_capacity, p_title, p_venue)
     OR (p_kind = 'consultation') <> (p_host_staff_user_id IS NOT NULL)
     OR p_kind = 'consultation' AND p_audience_wave_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_appointment_manager(p_project_id, (p_context).staff_user_id, p_kind,
    p_host_staff_user_id);
  IF p_kind = 'consultation' AND NOT public.appointment_member_roles(p_project_id,
       p_host_staff_user_id) && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'host_not_allowed';
  END IF;
  PERFORM public.assert_appointment_audience(p_project_id, p_audience_wave_id);
  IF p_starts_at <= now() THEN
    RAISE EXCEPTION 'starts_in_past';
  END IF;
  IF p_kind = 'consultation' THEN
    PERFORM public.assert_host_free(p_host_staff_user_id, p_id, p_starts_at, p_ends_at);
  END IF;
  INSERT INTO public.appointment (id, project_id, kind, host_staff_user_id, audience_wave_id,
    starts_at, ends_at, booking_closes_at, capacity, title, venue, created_by)
  VALUES (p_id, p_project_id, p_kind, p_host_staff_user_id, p_audience_wave_id, p_starts_at,
    p_ends_at, p_booking_closes_at, p_capacity, p_title, p_venue, (p_context).staff_user_id);
  PERFORM public.write_audit_event(p_project_id, NULL, 'appointment_created', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'appointmentId', p_id, 'kind', p_kind,
      'startsAt', public.appointment_instant(p_starts_at),
      'endsAt', public.appointment_instant(p_ends_at),
      'bookingClosesAt', public.appointment_instant(p_booking_closes_at),
      'capacity', p_capacity, 'hostStaffUserId', p_host_staff_user_id,
      'audienceWaveId', p_audience_wave_id)), false);
  RETURN p_id;
END $function$;

ALTER FUNCTION public.create_appointment(public.audit_context,uuid,uuid,public.appointment_kind,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_appointment(public.audit_context,uuid,uuid,public.appointment_kind,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_appointment(public.audit_context,uuid,uuid,public.appointment_kind,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text) TO transfer_app;
