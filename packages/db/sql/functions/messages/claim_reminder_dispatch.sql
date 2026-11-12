CREATE OR REPLACE FUNCTION public.claim_reminder_dispatch(p_reminder_id uuid, p_has_actions boolean, p_job_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participant_reminder;
  p public.participation;
  a public.appointment;
  b public.appointment_booking;
  ch public.participant_channel;
  k public.consent_record;
  v_refusal text;
  v_reason public.reminder_cancel_reason;
BEGIN
  IF p_reminder_id IS NULL OR p_has_actions IS NULL OR p_job_id IS NULL
     OR p_job_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  p := public.lock_participation(r.participation_id);
  IF r.appointment_id IS NOT NULL THEN
    SELECT * INTO a FROM public.appointment WHERE id = r.appointment_id FOR SHARE;
  END IF;
  IF r.booking_id IS NOT NULL THEN
    SELECT * INTO b FROM public.appointment_booking WHERE id = r.booking_id FOR SHARE;
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF r.status NOT IN ('queued', 'dispatching') THEN
    RETURN 'settled';
  END IF;
  SELECT * INTO ch FROM public.participant_channel WHERE id = r.channel_id FOR SHARE;
  SELECT * INTO k FROM public.consent_record WHERE id = r.consent_id FOR SHARE;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    v_reason := 'participation_closed';
  ELSIF ch.removed_at IS NOT NULL OR ch.suspended_at IS NOT NULL THEN
    v_reason := 'channel_unavailable';
  ELSIF ch.consent_id <> r.consent_id OR k.ended_at IS NOT NULL OR k.purpose <> 'portal_contact'
        OR k.text_version <> 'portal-contact-consent:v2' THEN
    v_reason := 'consent_ended';
  ELSIF r.requested_by IS NOT NULL
        AND NOT public.reminder_requester_allowed(r.participation_id, r.requested_by) THEN
    v_reason := 'requester_no_longer_authorized';
  ELSIF r.kind = 'open_items' AND NOT p_has_actions THEN
    v_reason := 'nothing_open';
  ELSIF r.kind::text = 'appointment_invitation' THEN
    v_refusal := public.appointment_booking_refusal(p, a, true);
    IF v_refusal = 'already_booked' THEN
      v_reason := 'nothing_open';
    ELSIF v_refusal IS NOT NULL THEN
      v_reason := 'appointment_unavailable';
    END IF;
  ELSIF r.kind::text = 'appointment_cancelled' AND b.status <> 'cancelled' THEN
    -- Never a cancellation notice for a booking that wasn't cancelled.
    RAISE EXCEPTION 'booking_not_cancelled';
  END IF;
  IF v_reason IS NULL THEN
    UPDATE public.participant_reminder SET status = 'dispatching', claimed_at = now()
    WHERE id = r.id;
    RETURN 'dispatching';
  END IF;
  IF r.status = 'dispatching' THEN
    PERFORM public.settle_reminder(r, 'delivery_unknown', NULL, p_job_id);
    RETURN 'settled';
  END IF;
  PERFORM public.settle_reminder(r, 'cancelled', v_reason, p_job_id);
  RETURN v_reason::text;
END $function$;

ALTER FUNCTION public.claim_reminder_dispatch(uuid,boolean,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.claim_reminder_dispatch(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_reminder_dispatch(uuid,boolean,text) TO transfer_app;
