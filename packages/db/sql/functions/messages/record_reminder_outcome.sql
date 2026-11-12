CREATE OR REPLACE FUNCTION public.record_reminder_outcome(p_reminder_id uuid, p_outcome public.reminder_status, p_cancel_reason public.reminder_cancel_reason, p_job_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participant_reminder;
BEGIN
  IF p_reminder_id IS NULL OR p_outcome IS NULL OR p_job_id IS NULL
     OR p_job_id !~ '^[A-Za-z0-9_.:-]{1,64}$'
     OR p_outcome::text NOT IN ('sent', 'failed', 'delivery_unknown', 'cancelled')
     OR (p_outcome = 'cancelled') <> (p_cancel_reason IS NOT NULL)
     OR p_outcome = 'cancelled' AND p_cancel_reason <> 'delivery_unavailable' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO r FROM public.participant_reminder WHERE id = p_reminder_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reminder_not_found';
  END IF;
  IF r.status NOT IN ('queued', 'dispatching') THEN
    IF r.status = p_outcome AND r.cancel_reason IS NOT DISTINCT FROM p_cancel_reason THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'reminder_settled';
  END IF;
  IF (p_outcome = 'cancelled') <> (r.status = 'queued') THEN
    RAISE EXCEPTION 'reminder_not_dispatching';
  END IF;
  PERFORM public.settle_reminder(r, p_outcome, p_cancel_reason, p_job_id);
  RETURN true;
END $function$;

ALTER FUNCTION public.record_reminder_outcome(uuid,public.reminder_status,public.reminder_cancel_reason,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_reminder_outcome(uuid,public.reminder_status,public.reminder_cancel_reason,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_reminder_outcome(uuid,public.reminder_status,public.reminder_cancel_reason,text) TO transfer_app;
