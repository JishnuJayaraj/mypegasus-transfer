CREATE OR REPLACE FUNCTION public.write_participant_data(p_participation_id uuid, p_context public.audit_context, p_personnel_number text DEFAULT NULL::text, p_last_name text DEFAULT NULL::text, p_first_name text DEFAULT NULL::text, p_birth_date date DEFAULT NULL::date, p_old_employment_end_date date DEFAULT NULL::date, p_address_street text DEFAULT NULL::text, p_address_postal_code text DEFAULT NULL::text, p_address_city text DEFAULT NULL::text, p_address_country text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_mobile text DEFAULT NULL::text, p_private_email text DEFAULT NULL::text, p_work_email text DEFAULT NULL::text, p_knowledge_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  i public.participant_identity;
  d public.participant_details;
  v_has_identity boolean;
  v_has_details boolean;
  v_fields text[];
  v_kept text[];
BEGIN
  -- The shared project lock, then the row lock: writers of one participation serialise.
  r := public.lock_participation(p_participation_id);
  PERFORM public.assert_context(p_context, p_participation_id, '{user,system}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF pg_catalog.num_nulls(p_address_street, p_address_postal_code, p_address_city,
      p_address_country) NOT IN (0, 4) THEN
    RAISE EXCEPTION 'address_incomplete';
  END IF;
  IF p_knowledge_date > public.berlin_today() THEN
    RAISE EXCEPTION 'knowledge_date_in_future';
  END IF;
  SELECT * INTO i FROM public.participant_identity WHERE participation_id = p_participation_id;
  v_has_identity := FOUND;
  SELECT * INTO d FROM public.participant_details WHERE participation_id = p_participation_id;
  v_has_details := FOUND;
  IF NOT v_has_identity AND pg_catalog.num_nulls(p_personnel_number, p_last_name, p_first_name) > 0 THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF v_has_identity AND p_personnel_number IS DISTINCT FROM NULL
      AND p_personnel_number IS DISTINCT FROM i.personnel_number THEN
    RAISE EXCEPTION 'personnel_number_immutable';
  END IF;
  -- The participant's own values stay (Q112).
  v_kept := coalesce(d.participant_maintained, '{}');
  IF 'address' = ANY (v_kept) THEN
    p_address_street := NULL; p_address_postal_code := NULL;
    p_address_city := NULL; p_address_country := NULL;
  END IF;
  IF 'phone' = ANY (v_kept) THEN p_phone := NULL; END IF;
  IF 'mobile' = ANY (v_kept) THEN p_mobile := NULL; END IF;
  IF 'privateEmail' = ANY (v_kept) THEN p_private_email := NULL; END IF;

  SELECT coalesce(pg_catalog.array_agg(c.field ORDER BY c.ord), '{}') INTO v_fields
  FROM (VALUES
    (1, 'personnelNumber', i.personnel_number IS DISTINCT FROM coalesce(p_personnel_number, i.personnel_number)),
    (2, 'lastName', i.last_name IS DISTINCT FROM coalesce(p_last_name, i.last_name)),
    (3, 'firstName', i.first_name IS DISTINCT FROM coalesce(p_first_name, i.first_name)),
    (4, 'birthDate', i.birth_date IS DISTINCT FROM coalesce(p_birth_date, i.birth_date)),
    (5, 'oldEmploymentEndDate', d.old_employment_end_date
      IS DISTINCT FROM coalesce(p_old_employment_end_date, d.old_employment_end_date)),
    (6, 'address', p_address_street IS NOT NULL
      AND ROW(d.address_street, d.address_postal_code, d.address_city, d.address_country)
      IS DISTINCT FROM ROW(p_address_street, p_address_postal_code, p_address_city, p_address_country)),
    (7, 'phone', d.phone IS DISTINCT FROM coalesce(p_phone, d.phone)),
    (8, 'mobile', d.mobile IS DISTINCT FROM coalesce(p_mobile, d.mobile)),
    (9, 'privateEmail', d.private_email IS DISTINCT FROM coalesce(p_private_email, d.private_email)),
    (10, 'workEmail', d.work_email IS DISTINCT FROM coalesce(p_work_email, d.work_email)),
    (11, 'knowledgeDate', d.knowledge_date IS DISTINCT FROM coalesce(p_knowledge_date, d.knowledge_date))
  ) AS c(ord, field, changed)
  WHERE c.changed;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF NOT v_has_identity THEN
      INSERT INTO public.participant_identity (participation_id, project_id, personnel_number, last_name,
        first_name, birth_date)
      VALUES (p_participation_id, r.project_id, p_personnel_number, p_last_name, p_first_name, p_birth_date);
    ELSIF v_fields && '{lastName,firstName,birthDate}' THEN
      UPDATE public.participant_identity
      SET last_name = coalesce(p_last_name, last_name), first_name = coalesce(p_first_name, first_name),
          birth_date = coalesce(p_birth_date, birth_date), updated_at = pg_catalog.now()
      WHERE participation_id = p_participation_id;
    END IF;
    IF NOT v_has_details AND v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail,knowledgeDate}' THEN
      INSERT INTO public.participant_details (participation_id, project_id, address_street,
        address_postal_code, address_city, address_country, phone, mobile, private_email, work_email,
        old_employment_end_date, knowledge_date)
      VALUES (p_participation_id, r.project_id, p_address_street, p_address_postal_code, p_address_city,
        p_address_country, p_phone, p_mobile, p_private_email, p_work_email, p_old_employment_end_date,
        p_knowledge_date);
    ELSIF v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail,knowledgeDate}' THEN
      UPDATE public.participant_details
      SET address_street = coalesce(p_address_street, address_street),
          address_postal_code = coalesce(p_address_postal_code, address_postal_code),
          address_city = coalesce(p_address_city, address_city),
          address_country = coalesce(p_address_country, address_country),
          phone = coalesce(p_phone, phone), mobile = coalesce(p_mobile, mobile),
          private_email = coalesce(p_private_email, private_email),
          work_email = coalesce(p_work_email, work_email),
          old_employment_end_date = coalesce(p_old_employment_end_date, old_employment_end_date),
          knowledge_date = coalesce(p_knowledge_date, knowledge_date),
          updated_at = pg_catalog.now()
      WHERE participation_id = p_participation_id;
    END IF;
  EXCEPTION
    -- Stable codes, never the offending value (the table's messages would name the constraint).
    WHEN unique_violation THEN
      RAISE EXCEPTION 'personnel_number_taken';
    WHEN check_violation THEN
      RAISE EXCEPTION 'invalid_argument';
  END;
  RETURN public.write_audit_event(r.project_id, p_participation_id, 'participant_data_changed', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields)),
    false);
END $function$;

ALTER FUNCTION public.write_participant_data(uuid,public.audit_context,text,text,text,date,date,text,text,text,text,text,text,text,text,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_participant_data(uuid,public.audit_context,text,text,text,date,date,text,text,text,text,text,text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_participant_data(uuid,public.audit_context,text,text,text,date,date,text,text,text,text,text,text,text,text,date) TO transfer_app;
