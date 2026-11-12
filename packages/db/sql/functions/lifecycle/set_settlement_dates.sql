CREATE OR REPLACE FUNCTION public.set_settlement_dates(p_context public.audit_context, p_project_id uuid, p_kug_final date, p_measure110 date, p_expected_kug_final date, p_expected_measure110 date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.project;
  v_fields text[] := '{}';
BEGIN
  PERFORM public.lock_project_setup(p_project_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.project_membership m
      JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
      WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
        AND m.role = 'back_office') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_project_id;
  IF (r.kug_final_settlement_date, r.measure110_settlement_date)
     IS DISTINCT FROM (p_expected_kug_final, p_expected_measure110) THEN
    RAISE EXCEPTION 'stale_settlement_dates';
  END IF;
  IF p_kug_final IS DISTINCT FROM r.kug_final_settlement_date THEN
    v_fields := v_fields || 'kugFinalSettlementDate'::text;
  END IF;
  IF p_measure110 IS DISTINCT FROM r.measure110_settlement_date THEN
    v_fields := v_fields || 'measure110SettlementDate'::text;
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN RAISE EXCEPTION 'project_unchanged'; END IF;
  UPDATE public.project SET kug_final_settlement_date = p_kug_final,
    measure110_settlement_date = p_measure110
  WHERE id = p_project_id;
  RETURN public.write_audit_event(p_project_id, NULL, 'settlement_dates_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields)), false);
END $function$;

ALTER FUNCTION public.set_settlement_dates(public.audit_context,uuid,date,date,date,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_settlement_dates(public.audit_context,uuid,date,date,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_settlement_dates(public.audit_context,uuid,date,date,date,date) TO transfer_app;
