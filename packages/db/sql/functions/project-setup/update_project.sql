CREATE OR REPLACE FUNCTION public.update_project(p_id uuid, p_context public.audit_context, p_name text DEFAULT NULL::text, p_customer_name text DEFAULT NULL::text, p_type public.project_type DEFAULT NULL::public.project_type, p_project_agentur_key text DEFAULT NULL::text, p_region_id uuid DEFAULT NULL::uuid, p_kug200a jsonb DEFAULT NULL::jsonb, p_dsv_template_version text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.project;
  v_fields text[] := '{}';
  v_kug200a jsonb := coalesce(p_kug200a, '{}');
  k text;
  v text;
  v_bad boolean;
BEGIN
  -- The exclusive project lock is the first operation (ADR-0002, project setup).
  PERFORM public.lock_project_setup(p_id);
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  SELECT * INTO r FROM public.project WHERE id = p_id;
  -- The DSV template's pin (ADR-0009, the DSV template), alone in its call.
  IF p_dsv_template_version IS NOT NULL THEN
    IF p_dsv_template_version !~ '^v[1-9][0-9]{0,3}$' OR p_name IS NOT NULL
       OR p_customer_name IS NOT NULL OR p_type IS NOT NULL OR p_project_agentur_key IS NOT NULL
       OR p_region_id IS NOT NULL OR p_kug200a IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    IF NOT EXISTS (
      SELECT FROM public.project_membership m
      JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
      WHERE m.project_id = p_id AND m.staff_user_id = (p_context).staff_user_id
        AND m.role = 'project_lead') THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    IF r.type <> 'ta_tg' THEN
      RAISE EXCEPTION 'not_ta_tg';
    END IF;
    IF EXISTS (SELECT FROM public.form_generation
               WHERE project_id = p_id AND form_code::text = 'dsv') THEN
      RAISE EXCEPTION 'template_pinned';
    END IF;
    IF r.dsv_template_version IS NOT DISTINCT FROM p_dsv_template_version THEN
      RAISE EXCEPTION 'project_unchanged';
    END IF;
    UPDATE public.project SET dsv_template_version = p_dsv_template_version WHERE id = p_id;
    RETURN public.write_audit_event(p_id, NULL, 'dsv_template_pinned', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'templateVersion', p_dsv_template_version,
        'previousVersion', r.dsv_template_version)), false);
  END IF;
  IF p_name IS NOT NULL AND NOT public.project_text_valid(p_name)
     OR p_customer_name IS NOT NULL AND NOT public.project_text_valid(p_customer_name)
     OR pg_catalog.jsonb_typeof(v_kug200a) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(v_kug200a) LOOP
    IF pg_catalog.jsonb_typeof(v_kug200a -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
    v := v_kug200a ->> k;
    -- An IF condition ends at its first THEN, so the CASE is assigned first.
    v_bad := CASE k
      WHEN 'tKugNumber' THEN v !~ '^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$' OR v ~* '^TK-'
      WHEN 'employerBetriebsnummer' THEN v !~ '^[0-9]{8}$'
      WHEN 'employerEconomicClass' THEN pg_catalog.char_length(v) NOT BETWEEN 1 AND 100
        OR v <> pg_catalog.btrim(v) OR v ~ '[[:cntrl:]]'
      ELSE true
    END;
    IF coalesce(v_bad, false) THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END LOOP;
  IF p_name IS DISTINCT FROM r.name AND p_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'name');
  END IF;
  IF p_customer_name IS DISTINCT FROM r.customer_name AND p_customer_name IS NOT NULL THEN
    v_fields := pg_catalog.array_append(v_fields, 'customerName');
  END IF;
  IF p_type IS DISTINCT FROM r.type AND p_type IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF EXISTS (SELECT FROM public.participation WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_participations';
    ELSIF EXISTS (SELECT FROM public.project_entry_wave WHERE project_id = p_id) THEN
      RAISE EXCEPTION 'project_has_waves';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'type');
  END IF;
  IF p_project_agentur_key IS DISTINCT FROM r.project_agentur_key AND p_project_agentur_key IS NOT NULL THEN
    IF r.status <> 'draft' THEN
      RAISE EXCEPTION 'project_not_draft';
    ELSIF NOT EXISTS (SELECT FROM public.project_template_pin
                      WHERE project_id = p_id AND agentur_key = p_project_agentur_key) THEN
      RAISE EXCEPTION 'agentur_not_pinned';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'projectAgenturKey');
  END IF;
  IF p_region_id IS DISTINCT FROM r.region_id AND p_region_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM public.region WHERE id = p_region_id) THEN
      RAISE EXCEPTION 'region_not_found';
    END IF;
    IF r.status <> 'draft' AND NOT EXISTS (
        SELECT FROM public.staff_org_role WHERE staff_user_id = (p_context).staff_user_id AND role = 'admin') THEN
      RAISE EXCEPTION 'project_not_draft';
    END IF;
    v_fields := pg_catalog.array_append(v_fields, 'regionId');
  END IF;
  IF v_kug200a ? 'tKugNumber' AND (v_kug200a ->> 'tKugNumber') IS DISTINCT FROM r.t_kug_number THEN
    v_fields := pg_catalog.array_append(v_fields, 'tKugNumber');
  END IF;
  IF v_kug200a ? 'employerBetriebsnummer'
     AND (v_kug200a ->> 'employerBetriebsnummer') IS DISTINCT FROM r.employer_betriebsnummer THEN
    v_fields := pg_catalog.array_append(v_fields, 'employerBetriebsnummer');
  END IF;
  IF v_kug200a ? 'employerEconomicClass'
     AND (v_kug200a ->> 'employerEconomicClass') IS DISTINCT FROM r.employer_economic_class THEN
    v_fields := pg_catalog.array_append(v_fields, 'employerEconomicClass');
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RAISE EXCEPTION 'project_unchanged';
  END IF;
  UPDATE public.project
  SET name = coalesce(p_name, name), customer_name = coalesce(p_customer_name, customer_name),
      type = coalesce(p_type, type),
      project_agentur_key = coalesce(p_project_agentur_key, project_agentur_key),
      region_id = coalesce(p_region_id, region_id),
      t_kug_number = CASE WHEN v_kug200a ? 'tKugNumber' THEN v_kug200a ->> 'tKugNumber'
        ELSE t_kug_number END,
      employer_betriebsnummer = CASE WHEN v_kug200a ? 'employerBetriebsnummer'
        THEN v_kug200a ->> 'employerBetriebsnummer' ELSE employer_betriebsnummer END,
      employer_economic_class = CASE WHEN v_kug200a ? 'employerEconomicClass'
        THEN v_kug200a ->> 'employerEconomicClass' ELSE employer_economic_class END
  WHERE id = p_id;
  RETURN public.write_audit_event(p_id, NULL, 'project_changed', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields),
      'type', CASE WHEN 'type' = ANY (v_fields) THEN p_type END,
      'projectAgenturKey', CASE WHEN 'projectAgenturKey' = ANY (v_fields) THEN p_project_agentur_key END,
      'regionId', CASE WHEN 'regionId' = ANY (v_fields) THEN p_region_id END)),
    false);
END $function$;

ALTER FUNCTION public.update_project(uuid,public.audit_context,text,text,public.project_type,text,uuid,jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.update_project(uuid,public.audit_context,text,text,public.project_type,text,uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_project(uuid,public.audit_context,text,text,public.project_type,text,uuid,jsonb,text) TO transfer_app;
