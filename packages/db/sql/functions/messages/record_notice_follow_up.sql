CREATE OR REPLACE FUNCTION public.record_notice_follow_up(p_context public.audit_context, p_reminder_id uuid, p_method public.notice_follow_up_method)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation uuid;
  p public.participation;
  r public.participant_reminder;
BEGIN
  IF p_reminder_id IS NULL OR p_method IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation FROM public.participant_reminder
  WHERE id = p_reminder_id AND kind::text IN ('appointment_changed', 'appointment_cancelled');
  IF v_participation IS NULL THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  PERFORM public.assert_appointment_context(p_context, v_participation);
  p := public.lock_participation(v_participation);
  IF NOT public.appointment_staff_allowed(p.id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF NOT (r.status IN ('failed', 'delivery_unknown')
          OR r.status = 'cancelled' AND r.cancel_reason <> 'participation_closed') THEN
    RAISE EXCEPTION 'notice_delivered';
  END IF;
  IF r.followed_up_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_followed_up';
  END IF;
  UPDATE public.participant_reminder SET followed_up_method = p_method,
    followed_up_by = (p_context).staff_user_id, followed_up_at = now()
  WHERE id = r.id;
  PERFORM public.write_audit_event(r.project_id, r.participation_id,
    'appointment_notice_followed_up', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('reminderId', r.id, 'appointmentId', r.appointment_id,
      'method', p_method), false);
END $function$;

ALTER FUNCTION public.record_notice_follow_up(public.audit_context,uuid,public.notice_follow_up_method) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_notice_follow_up(public.audit_context,uuid,public.notice_follow_up_method) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_notice_follow_up(public.audit_context,uuid,public.notice_follow_up_method) TO transfer_app;
