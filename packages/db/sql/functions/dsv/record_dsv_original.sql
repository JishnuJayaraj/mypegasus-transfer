CREATE OR REPLACE FUNCTION public.record_dsv_original(p_context public.audit_context, p_participation_id uuid, p_field text, p_value text, p_expected text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; c public.dsv_contract; v_current text;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF p_field IS NULL OR p_field NOT IN ('originalLocation', 'originalReceivedOn', 'sentToCustomerOn')
     OR p_value IS NULL
     OR p_field = 'originalLocation' AND p_value <> 'paper_personnel_file'
     OR p_field <> 'originalLocation' AND p_value !~ '^\d{4}-\d{2}-\d{2}$'
     OR p_expected IS NOT NULL AND p_field = 'originalLocation' AND p_expected <> 'paper_personnel_file'
     OR p_expected IS NOT NULL AND p_field <> 'originalLocation' AND p_expected !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL
     OR NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO c FROM public.dsv_contract WHERE participation_id = r.id
  ORDER BY created_at DESC, id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF p_field <> 'originalLocation' AND p_value::date > public.berlin_today() THEN
    RAISE EXCEPTION 'date_in_future';
  END IF;
  v_current := CASE p_field WHEN 'originalLocation' THEN c.original_location
    WHEN 'originalReceivedOn' THEN c.original_received_on::text ELSE c.sent_to_customer_on::text END;
  IF v_current IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'stale_value'; END IF;
  IF v_current = p_value THEN RAISE EXCEPTION 'value_unchanged'; END IF;
  UPDATE public.dsv_contract SET
    original_location = CASE WHEN p_field = 'originalLocation' THEN p_value ELSE original_location END,
    original_received_on = CASE WHEN p_field = 'originalReceivedOn' THEN p_value::date ELSE original_received_on END,
    sent_to_customer_on = CASE WHEN p_field = 'sentToCustomerOn' THEN p_value::date ELSE sent_to_customer_on END
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'dsv_original_recorded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('field', p_field,
      'location', CASE WHEN p_field = 'originalLocation' THEN p_value END)), false);
END $function$;

ALTER FUNCTION public.record_dsv_original(public.audit_context,uuid,text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_dsv_original(public.audit_context,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_dsv_original(public.audit_context,uuid,text,text,text) TO transfer_app;
