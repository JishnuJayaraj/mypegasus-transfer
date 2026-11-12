CREATE OR REPLACE FUNCTION public.record_customer_notice(p_context public.audit_context, p_participation_id uuid, p_notified_on date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF p_notified_on IS NULL THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF EXISTS (SELECT FROM public.dsv_customer_notice WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'notice_recorded';
  END IF;
  IF r.status <> 'withdrawn' OR r.dsv_status <> 'dsv_signed' OR r.withdrawn_on IS NULL THEN
    RAISE EXCEPTION 'notice_not_due';
  END IF;
  IF p_notified_on > public.berlin_today() THEN RAISE EXCEPTION 'date_in_future'; END IF;
  IF p_notified_on < r.withdrawn_on THEN RAISE EXCEPTION 'notice_before_withdrawal'; END IF;
  INSERT INTO public.dsv_customer_notice (id, project_id, participation_id, notified_on, recorded_by)
  VALUES (v_id, r.project_id, r.id, p_notified_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_customer_notified', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('notifiedOn', p_notified_on), false);
  RETURN v_id;
END $function$;

ALTER FUNCTION public.record_customer_notice(public.audit_context,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_customer_notice(public.audit_context,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_customer_notice(public.audit_context,uuid,date) TO transfer_app;
