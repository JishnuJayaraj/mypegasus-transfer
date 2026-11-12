CREATE OR REPLACE FUNCTION public.book_appointment(p_context public.audit_context, p_appointment_id uuid, p_participation_id uuid, p_id uuid, p_token_hash text DEFAULT NULL::text, p_follow_up_of uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participant boolean := (p_context).actor_type = 'participant';
  v_project uuid;
  v_refusal text;
  s public.participant_session;
  p public.participation;
  a public.appointment;
  f public.appointment_booking;
  v_followed_kind text;
BEGIN
  IF p_appointment_id IS NULL OR p_participation_id IS NULL OR p_id IS NULL
     OR coalesce(v_participant, false) = (p_token_hash IS NULL)
     OR v_participant AND p_follow_up_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_participant THEN
    PERFORM public.assert_context(p_context, p_participation_id, '{participant}');
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    IF v_project IS DISTINCT FROM s.project_id THEN
      RAISE EXCEPTION 'appointment_not_found';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
    SELECT * INTO p FROM public.participation WHERE id = s.participation_id;
  ELSE
    PERFORM public.assert_appointment_context(p_context, p_participation_id);
    IF v_project IS NULL THEN
      RAISE EXCEPTION 'appointment_not_found';
    END IF;
    IF NOT EXISTS (SELECT FROM public.participation
                   WHERE id = p_participation_id AND project_id = v_project) THEN
      RAISE EXCEPTION 'participation_not_found';
    END IF;
    p := public.lock_participation(p_participation_id);
    IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
      RAISE EXCEPTION 'project_not_active';
    END IF;
  END IF;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  v_refusal := public.appointment_booking_refusal(p, a, v_participant);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = v_refusal;
  END IF;
  IF p_follow_up_of IS NOT NULL THEN
    SELECT * INTO f FROM public.appointment_booking
    WHERE id = p_follow_up_of AND participation_id = p.id FOR UPDATE;
    IF f.id IS NULL THEN
      RAISE EXCEPTION 'follow_up_not_found';
    END IF;
    SELECT kind::text INTO v_followed_kind FROM public.appointment WHERE id = f.appointment_id;
    IF a.kind <> 'consultation' OR v_followed_kind <> 'consultation' THEN
      RAISE EXCEPTION 'follow_up_kind_mismatch';
    END IF;
    IF NOT public.booking_missed(f) THEN
      RAISE EXCEPTION 'follow_up_not_missed';
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.appointment_booking (id, project_id, participation_id, appointment_id,
      origin, booked_by, follow_up_of)
    VALUES (p_id, v_project, p.id, a.id,
      CASE WHEN v_participant THEN 'participant' ELSE 'staff' END::public.booking_origin,
      (p_context).staff_user_id, p_follow_up_of);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  PERFORM public.write_audit_event(v_project, p.id, 'appointment_booked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('bookingId', p_id, 'appointmentId', a.id,
      'appointmentKind', a.kind, 'startsAt', public.appointment_instant(a.starts_at),
      'origin', CASE WHEN v_participant THEN 'participant' ELSE 'staff' END,
      'followUpOf', p_follow_up_of), false);
  RETURN p_id;
END $function$;

ALTER FUNCTION public.book_appointment(public.audit_context,uuid,uuid,uuid,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.book_appointment(public.audit_context,uuid,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_appointment(public.audit_context,uuid,uuid,uuid,text,uuid) TO transfer_app;
