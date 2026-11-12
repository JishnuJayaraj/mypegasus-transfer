CREATE OR REPLACE FUNCTION public.queue_appointment_message(p public.participation, a public.appointment, p_kind public.reminder_kind, p_booking_id uuid, p_batch_id uuid, p_context public.audit_context)
 RETURNS public.participant_reminder
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  ch record;
  r public.participant_reminder;
  v_reason public.reminder_cancel_reason;
BEGIN
  SELECT c.id, c.kind, c.consent_id INTO ch
  FROM public.participant_channel c
  JOIN public.consent_record k ON k.id = c.consent_id
  WHERE c.participation_id = p.id AND c.removed_at IS NULL AND c.suspended_at IS NULL
    AND k.purpose = 'portal_contact' AND k.text_version = 'portal-contact-consent:v2'
    AND k.ended_at IS NULL
  ORDER BY c.kind = 'email' DESC, c.verified_at DESC, c.id
  LIMIT 1;
  IF NOT FOUND THEN
    v_reason := CASE WHEN EXISTS (SELECT FROM public.participant_channel c
                                  WHERE c.participation_id = p.id AND c.removed_at IS NULL
                                    AND c.suspended_at IS NULL)
                     THEN 'consent_required' ELSE 'no_channel' END;
  END IF;
  INSERT INTO public.participant_reminder (id, project_id, participation_id, batch_id, kind,
    message_version, language, channel_id, channel_kind, consent_id, requested_by, requested_on,
    status, cancel_reason, outcome_at, appointment_id, booking_id)
  VALUES (gen_random_uuid(), p.project_id, p.id, p_batch_id, p_kind,
    CASE WHEN p_kind::text = 'appointment_invitation' THEN 'portal-invitation:v1'
         ELSE 'portal-appointment-change:v1' END,
    coalesce((SELECT language FROM public.participant_account WHERE participation_id = p.id), 'de'),
    ch.id, ch.kind, ch.consent_id, (p_context).staff_user_id,
    (now() AT TIME ZONE 'Europe/Berlin')::date,
    CASE WHEN v_reason IS NULL THEN 'queued' ELSE 'cancelled' END::public.reminder_status,
    v_reason, CASE WHEN v_reason IS NOT NULL THEN now() END, a.id, p_booking_id)
  RETURNING * INTO r;
  PERFORM public.write_audit_event(p.project_id, p.id, 'reminder_queued', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('reminderId', r.id, 'batchId', p_batch_id,
      'kind', p_kind, 'channelKind', ch.kind, 'appointmentId', a.id,
      'startsAt', public.appointment_instant(a.starts_at)), false);
  IF v_reason IS NOT NULL THEN
    PERFORM public.write_audit_event(p.project_id, p.id, 'reminder_delivery', p_context, NULL,
      NULL, NULL, v_reason::text, NULL, pg_catalog.jsonb_build_object('reminderId', r.id,
        'outcome', 'cancelled', 'kind', p_kind, 'appointmentId', a.id), false);
  END IF;
  RETURN r;
END $function$;

ALTER FUNCTION public.queue_appointment_message(public.participation,public.appointment,public.reminder_kind,uuid,uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.queue_appointment_message(public.participation,public.appointment,public.reminder_kind,uuid,uuid,public.audit_context) FROM PUBLIC;
