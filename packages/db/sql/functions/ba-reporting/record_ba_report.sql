CREATE OR REPLACE FUNCTION public.record_ba_report(p_context public.audit_context, p_task_id uuid, p_outcome public.ba_reporting_status, p_reported_on date, p_reason public.ba_report_not_required_reason)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation_id uuid;
  v_shape_ok boolean := CASE p_outcome::text
    WHEN 'reported' THEN p_reported_on IS NOT NULL AND p_reason IS NULL
    WHEN 'not_required' THEN p_reason IS NOT NULL AND p_reported_on IS NULL
    ELSE false END;
  t public.ba_reporting_task;
BEGIN
  IF p_task_id IS NULL OR NOT coalesce(v_shape_ok, false) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- participation_id never changes, so it can be read before the lock.
  SELECT participation_id INTO v_participation_id FROM public.ba_reporting_task
  WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.lock_participation(v_participation_id);
  IF NOT public.document_staff_roles(v_participation_id, (p_context).staff_user_id)
      && ARRAY['project_lead', 'back_office'] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO t FROM public.ba_reporting_task WHERE id = p_task_id FOR UPDATE;
  IF t.status::text <> 'pending' THEN
    RAISE EXCEPTION 'already_recorded';
  END IF;
  IF p_reported_on > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  IF p_reported_on < public.ba_reporting_obligation_day(t.id) THEN
    RAISE EXCEPTION 'date_before_task';
  END IF;
  UPDATE public.ba_reporting_task SET status = p_outcome, reported_on = p_reported_on,
    not_required_reason = p_reason, decided_by = (p_context).staff_user_id, decided_at = now()
  WHERE id = t.id;
  PERFORM public.write_audit_event(t.project_id, t.participation_id, 'ba_report_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL,
    CASE p_outcome::text
      WHEN 'reported' THEN pg_catalog.jsonb_build_object('taskId', t.id,
        'kind', t.reporting_kind, 'outcome', p_outcome,
        'reportedOn', pg_catalog.to_char(p_reported_on, 'YYYY-MM-DD'))
      ELSE pg_catalog.jsonb_build_object('taskId', t.id, 'kind', t.reporting_kind,
        'outcome', p_outcome, 'reason', p_reason)
    END, false);
END $function$;

ALTER FUNCTION public.record_ba_report(public.audit_context,uuid,public.ba_reporting_status,date,public.ba_report_not_required_reason) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_ba_report(public.audit_context,uuid,public.ba_reporting_status,date,public.ba_report_not_required_reason) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_ba_report(public.audit_context,uuid,public.ba_reporting_status,date,public.ba_report_not_required_reason) TO transfer_app;
