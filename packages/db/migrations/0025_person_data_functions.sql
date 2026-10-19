-- Hand-written (Slice 2 plan, sections 5.3 and 5.10; PR 2f): the only write path of the person-data
-- tables. Same hardening as 0004 and 0011: SECURITY DEFINER owned by transfer_owner, a fixed
-- search_path with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for
-- transfer_app, refusals as P0001 with a stable code, never a value. The service validates the
-- values with the domain's import rules first; the function and the table CHECKs hold the structure.

-- Writes a participation's identity and personnel-file data. A null argument keeps the stored value
-- (nothing in Slice 2 clears one); the address is street, postal code, city and country together or
-- not at all. The first write needs the Personalnummer and both names; the Personalnummer never
-- changes afterwards. The changed fields are computed here with IS DISTINCT FROM and audited as
-- keys, never values; an unchanged write writes nothing and returns null, otherwise the event's id.
CREATE FUNCTION write_participant_data(
  p_participation_id uuid, p_context audit_context,
  p_personnel_number text DEFAULT NULL, p_last_name text DEFAULT NULL, p_first_name text DEFAULT NULL,
  p_birth_date date DEFAULT NULL, p_old_employment_end_date date DEFAULT NULL,
  p_address_street text DEFAULT NULL, p_address_postal_code text DEFAULT NULL,
  p_address_city text DEFAULT NULL, p_address_country text DEFAULT NULL, p_phone text DEFAULT NULL,
  p_mobile text DEFAULT NULL, p_private_email text DEFAULT NULL, p_work_email text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  i public.participant_identity;
  d public.participant_details;
  v_has_identity boolean;
  v_has_details boolean;
  v_fields text[];
BEGIN
  -- The shared project lock, then the row lock (D3): writers of one participation serialise.
  r := public.lock_participation(p_participation_id);
  PERFORM public.assert_context(p_context, p_participation_id, '{user,system}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF pg_catalog.num_nulls(p_address_street, p_address_postal_code, p_address_city,
      p_address_country) NOT IN (0, 4) THEN
    RAISE EXCEPTION 'address_incomplete';
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
    (10, 'workEmail', d.work_email IS DISTINCT FROM coalesce(p_work_email, d.work_email))
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
    IF NOT v_has_details AND v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail}' THEN
      INSERT INTO public.participant_details (participation_id, project_id, address_street,
        address_postal_code, address_city, address_country, phone, mobile, private_email, work_email,
        old_employment_end_date)
      VALUES (p_participation_id, r.project_id, p_address_street, p_address_postal_code, p_address_city,
        p_address_country, p_phone, p_mobile, p_private_email, p_work_email, p_old_employment_end_date);
    ELSIF v_fields && '{oldEmploymentEndDate,address,phone,mobile,privateEmail,workEmail}' THEN
      UPDATE public.participant_details
      SET address_street = coalesce(p_address_street, address_street),
          address_postal_code = coalesce(p_address_postal_code, address_postal_code),
          address_city = coalesce(p_address_city, address_city),
          address_country = coalesce(p_address_country, address_country),
          phone = coalesce(p_phone, phone), mobile = coalesce(p_mobile, mobile),
          private_email = coalesce(p_private_email, private_email),
          work_email = coalesce(p_work_email, work_email),
          old_employment_end_date = coalesce(p_old_employment_end_date, old_employment_end_date),
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
END $$;
--> statement-breakpoint

-- Replaced: person-data events are written only by write_participant_data.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed',
      'config_template_pinned', 'config_override_changed', 'rule_relaxation_requested',
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn',
      'project_activated', 'participant_data_changed') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context, NULL, NULL,
    NULL, p_reason_code, p_effective_date, p_details, coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

-- Grants (plan 5.3): transfer_app may only select the person-data tables.
GRANT SELECT ON TABLE participant_identity, participant_details TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION write_participant_data FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION write_participant_data TO transfer_app;
