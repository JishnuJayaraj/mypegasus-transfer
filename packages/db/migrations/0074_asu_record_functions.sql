-- Hand-written (ADR-0002, the ASU record; process-and-lifecycle.md, Arbeitsuchendmeldung and
-- dates; data-protection.md, the ASU record; Q184, Q186; readings Q201): the document type
-- catalog's version 5 with the ASU proof's operations, the route, the registration with the PL's
-- attestation, the proof's link, the knowledge date's correction and the person-data writer that
-- learns it, the quarantine by its own roles (the PL may quarantine a BA confirmation), the
-- history's projection rows and the grants. Same hardening as 0072: SECURITY
-- DEFINER owned by transfer_owner, a fixed search_path with pg_temp last, schema-qualified names,
-- no dynamic SQL, EXECUTE only for transfer_app, database time, refusals as P0001 with a stable
-- code, never a value. Audit details carry ids, codes and dates only: never the BA-Kundennummer
-- (its write is `sensitive_write` with its key) or the knowledge date. The event types 0073 added
-- are compared as text here, since this runs after it in the same migration run.
--
-- Lock order (ADR-0002, the ASU record): the project's advisory lock shared through
-- `lock_participation`, the participation row, its documents (`FOR SHARE` the proof a link
-- names), `participant_details`, `asu_record`, `asu_registration`, then the sensitive row.
-- Staff act as themselves in normal mode; assisted mode and break-glass grant nothing here.

ALTER TABLE audit_event DROP CONSTRAINT audit_event_lifecycle_has_participation;
--> statement-breakpoint
ALTER TABLE audit_event ADD CONSTRAINT audit_event_lifecycle_has_participation CHECK (
  participation_id IS NOT NULL OR event_type::text NOT IN (
    'participation_created', 'status_changed', 'entry_wave_assigned',
    'profiling_exception_requested', 'profiling_exception_approved',
    'profiling_exception_rejected', 'profiling_exception_revoked',
    'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed',
    'participation_created_manually', 'participation_dates_changed', 'sensitive_read',
    'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned',
    'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
    'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
    'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
    'one_time_code_exhausted', 'participant_logout', 'participant_login',
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended', 'placement_agentur_set',
    'self_service_notice_acknowledged', 'step_up_completed', 'step_up_failed',
    'assisted_mode_started', 'assisted_mode_ended', 'document_added', 'document_reviewed',
    'document_deleted', 'document_upload_rejected', 'reminder_queued', 'reminder_delivery',
    'audit_history_opened', 'appointment_booked', 'appointment_booking_cancelled',
    'attendance_recorded', 'attendance_superseded', 'information_delivery_confirmed',
    'attendance_conflict_escalated', 'attendance_conflict_resolved',
    'appointment_notice_followed_up', 'missed_appointment_resolved', 'profiling_session_changed',
    'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
    'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
    'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set'));
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): codes and dates in the `case`
-- stream, never the number or the knowledge date.
INSERT INTO audit_event_projection (event_type, field, stream, shows_change, shows_reason,
  detail_keys) VALUES
  ('asu_route_set', NULL, 'case', false, false, '{channel,previousChannel}'),
  ('asu_registration_recorded', NULL, 'case', false, false,
    '{channel,registeredOn,proofKind,attestationSource}'),
  ('asu_proof_linked', NULL, 'case', false, false, '{documentId}'),
  ('knowledge_date_set', NULL, 'case', false, false, '{change}');
--> statement-breakpoint

-- The field catalog's new keys (the history's field categories): the route and the registration.
INSERT INTO field_access_category (field_key, access_category) VALUES
  ('asuChannel', 'case_internal'), ('asuRegistration', 'case_internal');
--> statement-breakpoint

-- The quarantine's roles (data-protection.md, quarantine), the column 0073 added: the review roles
-- in every earlier version, as `quarantine_document` used them.
UPDATE document_type_policy SET quarantine_roles = review_roles;
--> statement-breakpoint

-- Catalog version 5 (packages/domain/src/documents/catalog.ts): version 4's rows, the ASU proof as
-- evidence (`signed`: normal mode only, never changed once reviewed; no signature is asked of it)
-- with its operations (Q186, Q201): added by the assigned consultant and the PL, reviewed by the
-- assigned consultant, quarantined at once by either (the PL without opening, reviewing or
-- linking it), deleted by the PL before its review. Documents of earlier versions keep their rows.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  generated, add_roles, review_roles, delete_roles, open_roles, quarantine_roles)
SELECT type, 5, retention_class, file_name, signed OR type = 'asu_proof', generated,
  CASE WHEN type = 'asu_proof' THEN '{consultant,project_lead}' ELSE add_roles END,
  CASE WHEN type = 'asu_proof' THEN '{consultant}' ELSE review_roles END,
  CASE WHEN type = 'asu_proof' THEN '{project_lead}' ELSE delete_roles END,
  open_roles,
  CASE WHEN type = 'asu_proof' THEN '{consultant,project_lead}' ELSE quarantine_roles END
FROM document_type_policy WHERE catalog_version = 4;
--> statement-breakpoint

-- Internal helper (no grant).

-- The actor of an ASU operation (data-protection.md, the ASU record): a staff user acting for
-- themselves (`actor_not_allowed` in assisted mode or without one of `p_roles`; a consultant only
-- while assigned, `document_staff_roles`), the participation locked (the shared project lock
-- first), a `ta_tg` project (`asu_not_applicable`, Q89) and an open participation
-- (`participation_closed`). Returns the locked participation.
CREATE FUNCTION lock_asu_actor(p_participation_id uuid, p_context audit_context, p_roles text[])
RETURNS participation LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && p_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- The route (process-and-lifecycle.md, Arbeitsuchendmeldung): set by the PL or the assigned
-- consultant with the version read (`stale_revision`), changeable until a registration is recorded
-- (`asu_registered`; an entry error is corrected through an approved correction, never by a new
-- route). An unchanged route writes nothing. Audited `asu_route_set` (the route and the one it
-- replaced). Returns the version.
CREATE FUNCTION set_asu_route(
  p_context audit_context, p_participation_id uuid, p_channel asu_channel, p_version integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  a public.asu_record;
BEGIN
  IF p_participation_id IS NULL OR p_channel IS NULL OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{project_lead,consultant}');
  SELECT * INTO a FROM public.asu_record WHERE participation_id = r.id FOR UPDATE;
  IF coalesce(a.version, 0) <> p_version THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'asu_registered';
  END IF;
  IF a.channel IS NOT DISTINCT FROM p_channel THEN
    RETURN p_version;
  END IF;
  INSERT INTO public.asu_record (participation_id, project_id, channel, version, set_by)
  VALUES (r.id, r.project_id, p_channel, 1, (p_context).staff_user_id)
  ON CONFLICT (participation_id) DO UPDATE SET channel = EXCLUDED.channel,
    version = public.asu_record.version + 1, set_by = EXCLUDED.set_by, set_at = now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_route_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'channel', p_channel, 'previousChannel', a.channel)), false);
  RETURN p_version + 1;
END $$;
--> statement-breakpoint

-- A registration on the route `online_self` or `in_person` (process-and-lifecycle.md,
-- Arbeitsuchendmeldung; Q184, Q186): its actual date, not after today in Berlin
-- (`registered_on_in_future`); on an unset route `asu_route_unset`; on the route the recorder
-- reviewed (`p_route_version`, `stale_revision` when it moved meanwhile, so an unseen change is
-- never frozen, Q201); on `kug_200b` `asu_route_kug200b` (the batch's submission records it, Slice
-- 6, PR 6-5a); one per participation (`asu_registered`). With the attestation (the PL only) its
-- proof comes at once: the BA-Kundennummer, upper case, 4–20 letters and digits
-- (`invalid_argument`, never the value), encrypted beside the RV-Nummer under the row's key
-- (`key_unknown` for another) and audited `sensitive_write`, and the source where the PL verified
-- it; a number alone is no proof of the date (Q184). Without it (the PL or the assigned consultant)
-- the proof is a BA confirmation linked by `link_asu_proof`. Audited `asu_registration_recorded`.
-- Returns the registration's id.
CREATE FUNCTION record_asu_registration(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_registered_on date,
  p_route_version integer, p_customer_number text DEFAULT NULL,
  p_attestation_source asu_attestation_source DEFAULT NULL, p_key text DEFAULT NULL,
  p_key_id text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  a public.asu_record;
  v_channel public.asu_channel;
  v_attested boolean := p_customer_number IS NOT NULL;
  v_number text := pg_catalog.upper(pg_catalog.btrim(p_customer_number));
  v_key_id text;
BEGIN
  IF p_participation_id IS NULL OR p_id IS NULL OR p_registered_on IS NULL
     OR p_route_version IS NULL OR v_attested <> (p_attestation_source IS NOT NULL)
     OR v_attested AND (v_number !~ '^[0-9A-Z]{4,20}$'
       OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
       OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context,
    CASE WHEN v_attested THEN '{project_lead}' ELSE '{project_lead,consultant}' END::text[]);
  SELECT * INTO a FROM public.asu_record WHERE participation_id = r.id FOR SHARE;
  v_channel := a.channel;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'asu_route_unset';
  END IF;
  IF a.version <> p_route_version THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF v_channel = 'kug_200b' THEN
    RAISE EXCEPTION 'asu_route_kug200b';
  END IF;
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'asu_registered';
  END IF;
  IF p_registered_on > public.berlin_today() THEN
    RAISE EXCEPTION 'registered_on_in_future';
  END IF;
  INSERT INTO public.asu_registration (id, project_id, participation_id, channel, registered_on,
    recorded_by, proof_kind, attestation_source, proof_linked_by, proof_linked_at)
  VALUES (p_id, r.project_id, r.id, v_channel, p_registered_on, (p_context).staff_user_id,
    CASE WHEN v_attested THEN 'ba_customer_number'::public.asu_proof_kind END,
    p_attestation_source,
    CASE WHEN v_attested THEN (p_context).staff_user_id END,
    CASE WHEN v_attested THEN now() END);
  IF v_attested THEN
    SELECT key_id INTO v_key_id FROM public.participant_identifier_data
    WHERE participation_id = r.id FOR UPDATE;
    IF v_key_id IS DISTINCT FROM p_key_id AND v_key_id IS NOT NULL THEN
      RAISE EXCEPTION 'key_unknown';
    END IF;
    INSERT INTO public.participant_identifier_data (participation_id, project_id,
      ba_customer_number, ba_customer_number_present, key_id)
    VALUES (r.id, r.project_id, public.seal_sensitive_value(r.id, 'baCustomerNumber',
      pg_catalog.to_jsonb(v_number), p_key), true, p_key_id)
    ON CONFLICT (participation_id) DO UPDATE SET
      ba_customer_number = EXCLUDED.ba_customer_number, ba_customer_number_present = true,
      written_at = now();
    PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
      NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'baCustomerNumber'), false);
  END IF;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_registration_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'registrationId', p_id, 'channel', v_channel,
      'registeredOn', pg_catalog.to_char(p_registered_on, 'YYYY-MM-DD'),
      'proofKind', CASE WHEN v_attested THEN 'ba_customer_number' END,
      'attestationSource', p_attestation_source)), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- The proof's link (process-and-lifecycle.md, Arbeitsuchendmeldung; Q201): the assigned consultant,
-- who reviewed and opens the BA confirmation, confirms that it supports the registration's date.
-- The document is an accepted, live `asu_proof` of the participation (`document_not_found`,
-- `document_not_accepted`), not quarantined (`document_quarantined`) or invalidated
-- (`document_invalidated`), held `FOR SHARE`; the registration has no proof yet
-- (`asu_registration_not_found`, `asu_proof_present`). The complete fact is recorded now, so a
-- proof accepted earlier counts from its link. Audited `asu_proof_linked`.
CREATE FUNCTION link_asu_proof(
  p_context audit_context, p_participation_id uuid, p_registration_id uuid, p_document_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
BEGIN
  IF p_participation_id IS NULL OR p_registration_id IS NULL OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{consultant}');
  SELECT * INTO d FROM public.document
  WHERE id = p_document_id AND participation_id = r.id AND type = 'asu_proof'
    AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF d.invalidated_by_correction IS NOT NULL THEN
    RAISE EXCEPTION 'document_invalidated';
  END IF;
  IF d.review_state <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  SELECT * INTO g FROM public.asu_registration
  WHERE id = p_registration_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asu_registration_not_found';
  END IF;
  IF g.proof_kind IS NOT NULL THEN
    RAISE EXCEPTION 'asu_proof_present';
  END IF;
  UPDATE public.asu_registration SET proof_kind = 'ba_confirmation', proof_document_id = d.id,
    proof_linked_by = (p_context).staff_user_id, proof_linked_at = now()
  WHERE id = g.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_proof_linked', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('registrationId', g.id, 'documentId', d.id),
    false);
END $$;
--> statement-breakpoint

-- The knowledge date's correction (process-and-lifecycle.md, dates): the PL, with the date
-- read (`stale_value`), set, changed or cleared, not after today in Berlin
-- (`knowledge_date_in_future`); the individual's fact, never a wave's. A terminal participation
-- takes none (`participation_closed`). An unchanged date writes nothing. Audited
-- `knowledge_date_set` with the kind of change, never the date.
CREATE FUNCTION set_knowledge_date(
  p_context audit_context, p_participation_id uuid, p_knowledge_date date, p_previous date
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  v_current date;
BEGIN
  IF p_participation_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  SELECT knowledge_date INTO v_current FROM public.participant_details
  WHERE participation_id = r.id FOR UPDATE;
  IF v_current IS DISTINCT FROM p_previous THEN
    RAISE EXCEPTION 'stale_value';
  END IF;
  IF p_knowledge_date > public.berlin_today() THEN
    RAISE EXCEPTION 'knowledge_date_in_future';
  END IF;
  IF v_current IS NOT DISTINCT FROM p_knowledge_date THEN
    RETURN;
  END IF;
  INSERT INTO public.participant_details (participation_id, project_id, knowledge_date)
  VALUES (r.id, r.project_id, p_knowledge_date)
  ON CONFLICT (participation_id) DO UPDATE SET knowledge_date = EXCLUDED.knowledge_date,
    updated_at = now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'knowledge_date_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('change', CASE
      WHEN p_knowledge_date IS NULL THEN 'cleared'
      WHEN v_current IS NULL THEN 'set'
      ELSE 'changed' END), false);
END $$;
--> statement-breakpoint

-- The person-data writer (Q112), as 0048 wrote it, and the knowledge date the import carries
-- (process-and-lifecycle.md, dates): not after today in Berlin (`knowledge_date_in_future`); a null
-- keeps the stored one, like every other value. Audited in `participant_data_changed` as
-- `knowledgeDate`.
DROP FUNCTION "public"."write_participant_data"(uuid, "public"."audit_context", text, text, text, date, date, text, text, text, text, text, text, text, text);
--> statement-breakpoint
CREATE FUNCTION write_participant_data(
  p_participation_id uuid, p_context audit_context,
  p_personnel_number text DEFAULT NULL, p_last_name text DEFAULT NULL, p_first_name text DEFAULT NULL,
  p_birth_date date DEFAULT NULL, p_old_employment_end_date date DEFAULT NULL,
  p_address_street text DEFAULT NULL, p_address_postal_code text DEFAULT NULL,
  p_address_city text DEFAULT NULL, p_address_country text DEFAULT NULL, p_phone text DEFAULT NULL,
  p_mobile text DEFAULT NULL, p_private_email text DEFAULT NULL, p_work_email text DEFAULT NULL,
  p_knowledge_date date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
END $$;
--> statement-breakpoint

-- Quarantine at once (data-protection.md, quarantine; Q183), as 0072 wrote it, by the policy's
-- quarantine roles: the review roles, and for the ASU proof the PL too (Q201), who gains no
-- opening, review or link by it.
CREATE OR REPLACE FUNCTION quarantine_document(
  p_context audit_context, p_document_id uuid, p_reason document_quarantine_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT quarantine_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  UPDATE public.document SET quarantine_reason = p_reason,
    quarantined_by = (p_context).staff_user_id, quarantined_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_quarantined',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- The lift, as 0072 wrote it, by the quarantine roles: whoever quarantined it, while they may
-- still, or the PL.
CREATE OR REPLACE FUNCTION lift_document_quarantine(p_context audit_context, p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF NOT v_roles && (SELECT quarantine_roles FROM public.document_type_policy
                     WHERE type = d.type AND catalog_version = d.catalog_version)
     OR d.quarantined_by IS DISTINCT FROM (p_context).staff_user_id
       AND NOT 'project_lead' = ANY (v_roles) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.quarantined_at IS NULL THEN
    RAISE EXCEPTION 'document_not_quarantined';
  END IF;
  UPDATE public.document SET quarantine_reason = NULL, quarantined_by = NULL,
    quarantined_at = NULL, quarantine_lifted_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id,
    'document_quarantine_lifted', p_context, NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- Replaced: the ASU events are written only by their functions too.
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
      'project_activated', 'participant_data_changed', 'participation_dates_changed',
      'project_member_added', 'project_member_removed', 'participant_assigned',
      'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
      'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
      'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
      'one_time_code_exhausted', 'participant_logout', 'participant_login',
      'contact_channel_removed', 'consent_ended', 'contact_channels_suspended',
      'placement_agentur_set', 'self_service_notice_acknowledged', 'step_up_completed',
      'step_up_failed', 'assisted_mode_started', 'assisted_mode_ended', 'document_opened',
      'document_added', 'document_reviewed', 'document_deleted', 'document_upload_rejected',
      'reminder_queued', 'reminder_delivery', 'audit_history_opened', 'appointment_created',
      'appointment_changed', 'appointment_cancelled', 'appointment_booked',
      'appointment_booking_cancelled', 'attendance_recorded', 'attendance_superseded',
      'information_delivery_confirmed', 'attendance_conflict_escalated',
      'attendance_conflict_resolved', 'appointment_notice_followed_up',
      'missed_appointment_resolved', 'profiling_session_changed',
      'profiling_declarations_recorded', 'form_generated', 'document_quarantined',
      'document_quarantine_lifted', 'signed_declaration_recorded', 'asu_route_set',
      'asu_registration_recorded', 'asu_proof_linked', 'knowledge_date_set') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context,
    NULL, NULL, NULL, p_reason_code, p_effective_date, p_details,
    coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

-- Grants: transfer_app selects the ASU tables and the BA-Kundennummer's presence (never its
-- ciphertext) and writes nothing; it executes the ASU functions and the person-data writer again.
GRANT SELECT ON TABLE asu_record, asu_registration TO transfer_app;
--> statement-breakpoint
GRANT SELECT (ba_customer_number_present) ON TABLE participant_identifier_data TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_asu_actor, set_asu_route, record_asu_registration, link_asu_proof,
  set_knowledge_date, write_participant_data FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_asu_route, record_asu_registration, link_asu_proof,
  set_knowledge_date, write_participant_data TO transfer_app;
