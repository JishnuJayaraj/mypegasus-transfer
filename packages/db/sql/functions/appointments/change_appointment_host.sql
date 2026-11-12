CREATE OR REPLACE FUNCTION public.change_appointment_host(p_context public.audit_context, p_id uuid, p_expected_version integer, p_host uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project uuid;
  a public.appointment;
BEGIN
  IF p_id IS NULL OR p_expected_version IS NULL OR p_host IS NULL THEN
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
  PERFORM FROM public.appointment_booking WHERE appointment_id = p_id AND status = 'booked'
  ORDER BY id FOR SHARE;
  IF NOT 'project_lead' = ANY (public.appointment_member_roles(v_project,
       (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF a.kind <> 'consultation' THEN
    RAISE EXCEPTION 'not_consultation';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'appointment_cancelled';
  END IF;
  IF a.starts_at <= now() THEN
    RAISE EXCEPTION 'appointment_started';
  END IF;
  IF a.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale_version';
  END IF;
  IF a.host_staff_user_id = p_host THEN
    RAISE EXCEPTION 'appointment_unchanged';
  END IF;
  IF NOT public.appointment_member_roles(v_project, p_host) && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'host_not_allowed';
  END IF;
  IF EXISTS (SELECT FROM public.appointment_booking b
             WHERE b.appointment_id = p_id AND b.status = 'booked'
               AND NOT public.appointment_staff_allowed(b.participation_id, p_host)) THEN
    RAISE EXCEPTION 'host_not_responsible';
  END IF;
  PERFORM public.assert_host_free(p_host, p_id, a.starts_at, a.ends_at);
  UPDATE public.appointment SET host_staff_user_id = p_host, version = version + 1
  WHERE id = p_id
  RETURNING * INTO a;
  PERFORM public.write_audit_event(v_project, NULL, 'appointment_changed', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('appointmentId', p_id,
      'version', a.version, 'fields', '["hostStaffUserId"]'::jsonb, 'hostStaffUserId', p_host),
    false);
  RETURN a.version;
END $function$;

ALTER FUNCTION public.change_appointment_host(public.audit_context,uuid,integer,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.change_appointment_host(public.audit_context,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_appointment_host(public.audit_context,uuid,integer,uuid) TO transfer_app;
