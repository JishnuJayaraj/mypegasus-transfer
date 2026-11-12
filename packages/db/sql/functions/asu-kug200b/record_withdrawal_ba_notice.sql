CREATE OR REPLACE FUNCTION public.record_withdrawal_ba_notice(p_context public.audit_context, p_participation_id uuid, p_withdrawal_id uuid, p_notified_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  w public.kug200b_withdrawal;
BEGIN
  IF p_participation_id IS NULL OR p_withdrawal_id IS NULL OR p_notified_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, false);
  SELECT * INTO w FROM public.kug200b_withdrawal
  WHERE id = p_withdrawal_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal_not_found';
  END IF;
  IF w.ba_notified_on IS NOT NULL THEN
    RAISE EXCEPTION 'ba_notice_recorded';
  END IF;
  IF p_notified_on > public.berlin_today() THEN
    RAISE EXCEPTION 'notified_on_in_future';
  END IF;
  IF p_notified_on < w.received_on THEN
    RAISE EXCEPTION 'notified_before_receipt';
  END IF;
  UPDATE public.kug200b_withdrawal SET ba_notified_on = p_notified_on,
    ba_notified_by = (p_context).staff_user_id, ba_notified_at = now()
  WHERE id = w.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'declaration_withdrawal_ba_notified',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('withdrawalId', w.id,
      'notifiedOn', pg_catalog.to_char(p_notified_on, 'YYYY-MM-DD')), false);
END $function$;

ALTER FUNCTION public.record_withdrawal_ba_notice(public.audit_context,uuid,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_withdrawal_ba_notice(public.audit_context,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_withdrawal_ba_notice(public.audit_context,uuid,uuid,date) TO transfer_app;
