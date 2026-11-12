CREATE OR REPLACE FUNCTION public.update_appointment(p_context public.audit_context, p_id uuid, p_expected_version integer, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_booking_closes_at timestamp with time zone, p_capacity integer, p_title text, p_venue text, p_audience_wave_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project uuid;
  a public.appointment;
  b public.appointment_booking;
  v_fields text[] := '{}';
  v_frozen text[];
  v_batch uuid := gen_random_uuid();
BEGIN
  IF p_id IS NULL OR p_expected_version IS NULL
     OR NOT public.appointment_values_valid(p_starts_at, p_ends_at, p_booking_closes_at,
       p_capacity, p_title, p_venue) THEN
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
  PERFORM public.assert_appointment_manager(v_project, (p_context).staff_user_id, a.kind,
    a.host_staff_user_id);
  IF a.kind = 'consultation' AND p_audience_wave_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF a.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_version';
  END IF;
  IF p_starts_at <> a.starts_at THEN v_fields := v_fields || 'startsAt'::text; END IF;
  IF p_ends_at <> a.ends_at THEN v_fields := v_fields || 'endsAt'::text; END IF;
  IF p_booking_closes_at <> a.booking_closes_at THEN v_fields := v_fields || 'bookingClosesAt'::text; END IF;
  IF p_capacity <> a.capacity THEN v_fields := v_fields || 'capacity'::text; END IF;
  IF p_title IS DISTINCT FROM a.title THEN v_fields := v_fields || 'title'::text; END IF;
  IF p_venue <> a.venue THEN v_fields := v_fields || 'venue'::text; END IF;
  IF p_audience_wave_id IS DISTINCT FROM a.audience_wave_id THEN
    v_fields := v_fields || 'audienceWaveId'::text;
  END IF;
  v_frozen := ARRAY(SELECT f FROM unnest(v_fields) f
                    WHERE f IN ('startsAt', 'endsAt', 'bookingClosesAt', 'audienceWaveId'));
  IF pg_catalog.cardinality(v_frozen) > 0
     AND (EXISTS (SELECT FROM public.appointment_booking WHERE appointment_id = p_id)
          OR EXISTS (SELECT FROM public.participant_reminder
                     WHERE appointment_id = p_id AND kind::text = 'appointment_invitation')) THEN
    RAISE EXCEPTION 'appointment_in_use';
  END IF;
  IF ('startsAt' = ANY (v_fields) OR 'endsAt' = ANY (v_fields)) AND p_starts_at <= now() THEN
    RAISE EXCEPTION 'starts_in_past';
  END IF;
  IF 'audienceWaveId' = ANY (v_fields) THEN
    PERFORM public.assert_appointment_audience(v_project, p_audience_wave_id);
  END IF;
  IF p_capacity < (SELECT pg_catalog.count(*) FROM public.appointment_booking
                   WHERE appointment_id = p_id AND status = 'booked') THEN
    RAISE EXCEPTION 'capacity_below_bookings';
  END IF;
  IF a.kind = 'consultation' AND ('startsAt' = ANY (v_fields) OR 'endsAt' = ANY (v_fields)) THEN
    PERFORM public.assert_host_free(a.host_staff_user_id, p_id, p_starts_at, p_ends_at);
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'appointment_unchanged';
  END IF;
  UPDATE public.appointment SET starts_at = p_starts_at, ends_at = p_ends_at,
    booking_closes_at = p_booking_closes_at, capacity = p_capacity, title = p_title,
    venue = p_venue, audience_wave_id = p_audience_wave_id, version = version + 1
  WHERE id = p_id
  RETURNING * INTO a;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('appointmentId', p_id,
      'version', a.version, 'fields', pg_catalog.to_jsonb(v_fields)), false);
  IF v_fields && '{title,venue}'::text[] AND a.starts_at > now() THEN
    FOR b IN SELECT * FROM public.appointment_booking
             WHERE appointment_id = p_id AND status = 'booked' ORDER BY id FOR SHARE LOOP
      PERFORM public.queue_appointment_notice(b, a, 'appointment_changed', v_batch, p_context);
    END LOOP;
  END IF;
  RETURN a.version;
END $function$;

ALTER FUNCTION public.update_appointment(public.audit_context,uuid,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.update_appointment(public.audit_context,uuid,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment(public.audit_context,uuid,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer,text,text,uuid) TO transfer_app;
