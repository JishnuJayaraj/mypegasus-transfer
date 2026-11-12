CREATE OR REPLACE FUNCTION public.request_invitations(p_context public.audit_context, p_appointment_id uuid, p_participation_ids uuid[], p_batch_id uuid)
 RETURNS TABLE(participation_id uuid, reminder_id uuid, channel_kind public.contact_channel_kind, not_deliverable text, skip text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_staff uuid := (p_context).staff_user_id;
  v_project uuid;
  v_roles text[];
  v_id uuid;
  v_refusal text;
  p public.participation;
  a public.appointment;
  r public.participant_reminder;
  latest public.participant_reminder;
BEGIN
  IF p_appointment_id IS NULL OR p_batch_id IS NULL OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM unnest(p_participation_ids) x)
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_appointment_context(p_context, NULL);
  SELECT project_id INTO v_project FROM public.appointment WHERE id = p_appointment_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'appointment_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project);
  IF EXISTS (SELECT FROM unnest(p_participation_ids) x
             WHERE NOT EXISTS (SELECT FROM public.participation q
                               WHERE q.id = x AND q.project_id = v_project)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  v_roles := public.appointment_member_roles(v_project, v_staff);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF NOT 'project_lead' = ANY (v_roles) AND EXISTS (
    SELECT FROM unnest(p_participation_ids) x
    WHERE NOT EXISTS (SELECT FROM public.participant_assignment s
                      WHERE s.participation_id = x AND s.staff_user_id = v_staff
                        AND s.ended_at IS NULL)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (SELECT status FROM public.project WHERE id = v_project) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;
  PERFORM FROM public.participation WHERE id = ANY (p_participation_ids) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM public.appointment WHERE id = p_appointment_id FOR UPDATE;
  IF a.status = 'cancelled' THEN RAISE EXCEPTION 'appointment_cancelled'; END IF;
  IF a.starts_at <= now() THEN RAISE EXCEPTION 'appointment_started'; END IF;
  IF a.booking_closes_at <= now() THEN RAISE EXCEPTION 'booking_closed'; END IF;
  IF (SELECT pg_catalog.count(*) FROM public.appointment_booking
      WHERE appointment_id = a.id AND status = 'booked') >= a.capacity THEN
    RAISE EXCEPTION 'appointment_full';
  END IF;

  FOREACH v_id IN ARRAY p_participation_ids LOOP
    SELECT * INTO p FROM public.participation WHERE id = v_id;
    participation_id := v_id;
    reminder_id := NULL;
    channel_kind := NULL;
    not_deliverable := NULL;
    skip := NULL;
    v_refusal := public.appointment_booking_refusal(p, a, true);
    SELECT * INTO latest FROM public.participant_reminder x
    WHERE x.participation_id = v_id AND x.appointment_id = a.id
      AND x.kind::text = 'appointment_invitation'
    ORDER BY x.requested_at DESC, x.id DESC LIMIT 1;
    IF v_refusal = 'participation_closed' THEN
      skip := 'participation_closed';
    ELSIF v_refusal = 'already_booked' THEN
      skip := 'already_booked';
    ELSIF v_refusal IS NOT NULL THEN
      skip := 'not_eligible';
    ELSIF latest.id IS NOT NULL AND NOT (latest.status = 'failed' OR latest.status = 'cancelled'
          AND latest.cancel_reason::text IN ('no_channel', 'consent_required',
            'channel_unavailable', 'consent_ended', 'delivery_unavailable',
            'requester_no_longer_authorized')) THEN
      skip := 'already_invited';
    ELSIF (SELECT pg_catalog.count(*) FROM public.participant_reminder x
           WHERE x.participation_id = v_id AND x.appointment_id = a.id
             AND x.kind::text = 'appointment_invitation'
             AND x.status IN ('sent', 'failed', 'delivery_unknown')) >= 3 THEN
      skip := 'invitation_limit';
    ELSE
      r := public.queue_appointment_message(p, a, 'appointment_invitation', NULL, p_batch_id,
        p_context);
      reminder_id := r.id;
      channel_kind := r.channel_kind;
      not_deliverable := r.cancel_reason::text;
    END IF;
    RETURN NEXT;
  END LOOP;
END $function$;

ALTER FUNCTION public.request_invitations(public.audit_context,uuid,uuid[],uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_invitations(public.audit_context,uuid,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_invitations(public.audit_context,uuid,uuid[],uuid) TO transfer_app;
