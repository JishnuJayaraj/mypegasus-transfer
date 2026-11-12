CREATE OR REPLACE FUNCTION public.review_document(p_context public.audit_context, p_document_id uuid, p_decision public.document_review_state, p_reason public.document_review_reason, p_signed_on date DEFAULT NULL::date, p_countersigned_on date DEFAULT NULL::date, p_confirmations text[] DEFAULT NULL::text[], p_form_version text DEFAULT NULL::text, p_declarations jsonb DEFAULT NULL::jsonb, p_dsv jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  d public.document;
  g public.form_generation;
  c public.consent_record;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_generation_id uuid;
  v_roles text[];
  v_id uuid;
  v_accept boolean := p_decision = 'accepted';
  v_paper boolean := p_signed_on IS NOT NULL OR p_countersigned_on IS NOT NULL
    OR p_confirmations IS NOT NULL OR p_form_version IS NOT NULL OR p_declarations IS NOT NULL;
  v_kug boolean;
  v_version text;
  v_choice text;
  v_contact text;
  v_signed_on date;
  v_consent uuid;
  v_in_force boolean;
  v_text text;
BEGIN
  IF p_document_id IS NULL OR p_decision IS NULL OR p_decision = 'unreviewed'
     OR (p_decision = 'rejected') <> (p_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id, generation_document_id INTO v_participation_id, v_generation_id
  FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  -- The documents in id order: the generation held, the scan changed.
  FOR v_id IN SELECT id FROM public.document
    WHERE id IN (p_document_id, v_generation_id) ORDER BY id LOOP
    IF v_id = p_document_id THEN
      SELECT * INTO d FROM public.document WHERE id = v_id AND deleted_at IS NULL FOR UPDATE;
    ELSE
      PERFORM FROM public.document WHERE id = v_id FOR SHARE;
    END IF;
  END LOOP;
  IF d.id IS NULL THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.review_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.review_state <> 'unreviewed' THEN
    RAISE EXCEPTION 'document_reviewed';
  END IF;
  IF d.quarantined_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_quarantined';
  END IF;
  IF (d.type IN ('dsv_signed_scan', 'dsv_cancellation') AND v_accept) <> (p_dsv IS NOT NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  -- The cancellation of the signed contract (process-and-lifecycle.md, the cancellation): accepted
  -- only with the three parties' signatures confirmed, while the participation is `informed` on the
  -- signed DSV; a rejection creates no fact and is always possible.
  IF d.type = 'dsv_cancellation' AND v_accept THEN
    IF NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id AND ended_as = 'signed') THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF NOT EXISTS (SELECT FROM public.participation WHERE id = d.participation_id AND status = 'informed' AND dsv_status = 'dsv_signed') THEN RAISE EXCEPTION 'cancellation_not_open'; END IF;
    IF p_dsv ? 'termsConfirmed' THEN RAISE EXCEPTION 'invalid_argument'; END IF;
    PERFORM public.validate_dsv_scan(p_dsv->'signatures', d.dsv_received_on);
    IF NOT (p_dsv->'signatures') ?& ARRAY['participant', 'customer', 'transfergesellschaft'] THEN
      RAISE EXCEPTION 'cancellation_signatures_missing';
    END IF;
    INSERT INTO public.dsv_scan_signature(project_id, participation_id, document_id, kind, signed_on)
    SELECT d.project_id, d.participation_id, d.id, key, value::date FROM jsonb_each_text(p_dsv->'signatures');
  END IF;
  IF d.type = 'dsv_signed_scan' THEN
    -- A rejection creates no fact, so it is allowed after the offer ended; an acceptance needs the
    -- open offer or the signed one (the countersigned original), never a declined or expired one.
    IF v_accept AND NOT EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id
        AND (ended_as IS NULL OR ended_as = 'signed')) THEN RAISE EXCEPTION 'source_changed'; END IF;
    IF v_accept THEN
      PERFORM public.validate_dsv_scan(p_dsv->'signatures', d.dsv_received_on);
      PERFORM public.assert_dsv_participant_date(d.dsv_offer_id, p_dsv->'signatures'->>'participant', d.id);
      IF EXISTS (SELECT FROM public.dsv_offer WHERE id = d.dsv_offer_id AND origin = 'external_paper')
         AND (p_dsv->>'termsConfirmed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'terms_mismatch'; END IF;
      INSERT INTO public.dsv_scan_signature(project_id, participation_id, document_id, kind, signed_on)
      SELECT d.project_id, d.participation_id, d.id, key, value::date FROM jsonb_each_text(p_dsv->'signatures');
    END IF;
  END IF;
  v_kug := d.type::text = 'kug200b_signed_scan';
  IF d.scan_origin IS NULL THEN
    IF v_paper THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  ELSE
    IF (SELECT status FROM public.participation WHERE id = d.participation_id)
       IN ('withdrawn', 'ta_completed', 'exited') THEN
      RAISE EXCEPTION 'participation_closed';
    END IF;
    IF v_accept <> v_paper
       OR v_accept AND (p_signed_on IS NULL OR p_confirmations IS NULL
         OR (d.scan_origin = 'external_paper') <> (p_form_version IS NOT NULL)
         OR p_form_version !~ '^(0[1-9]|1[0-2])-[0-9]{4}$')
       OR v_accept AND v_kug AND (p_countersigned_on IS NOT NULL OR p_declarations IS NOT NULL
         OR NOT p_confirmations @> '{declarations_ticked,mandatory_completed,signature_present}'::text[]
         OR NOT p_confirmations <@ '{declarations_ticked,mandatory_completed,signature_present}'::text[])
       OR v_accept AND NOT v_kug AND (p_countersigned_on IS NULL
         OR NOT p_confirmations @> '{signatures_present,all_pages_present}'::text[]
         OR NOT p_confirmations <@ '{signatures_present,all_pages_present}'::text[]
         OR NOT public.scan_declarations_valid(p_declarations)
         OR d.scan_origin = 'external_paper' AND p_declarations ->> 'kind' = 'as_printed') THEN
      RAISE EXCEPTION 'invalid_argument';
    END IF;
  END IF;
  IF v_accept AND d.scan_origin IS NOT NULL THEN
    v_signed_on := greatest(p_signed_on, p_countersigned_on);
    IF v_signed_on > public.berlin_today() THEN
      RAISE EXCEPTION 'signature_in_future';
    END IF;
    IF d.scan_origin = 'generated' THEN
      SELECT * INTO g FROM public.form_generation WHERE document_id = d.generation_document_id;
      IF least(p_signed_on, coalesce(p_countersigned_on, p_signed_on))
         < (g.generated_at AT TIME ZONE 'Europe/Berlin')::date THEN
        RAISE EXCEPTION 'signature_before_generation';
      END IF;
    END IF;
    v_version := coalesce(d.form_version, p_form_version);
    UPDATE public.document SET review_state = 'accepted', reviewed_by = (p_context).staff_user_id,
      reviewed_at = now(), form_code = public.scan_form(d.type), form_version = v_version,
      signed_on = p_signed_on, countersigned_on = p_countersigned_on,
      review_confirmations = CASE WHEN v_kug
        THEN '{declarations_ticked,mandatory_completed,signature_present}'::text[]
        ELSE '{signatures_present,all_pages_present}'::text[] END
    WHERE id = d.id;
    IF v_kug THEN
      INSERT INTO public.signed_declaration (id, project_id, participation_id, document_id,
        form_code, form_version, declaration, value, signed_on, recorded_by)
      VALUES
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id, 'kug200b',
          v_version, 'kug200bJobSeeking', 'yes', v_signed_on, (p_context).staff_user_id),
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id, 'kug200b',
          v_version, 'kug200bProfileAccess', 'yes', v_signed_on, (p_context).staff_user_id);
      PERFORM public.write_audit_event(d.project_id, d.participation_id,
        'signed_declaration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('documentId', d.id, 'formCode', 'kug200b',
          'formVersion', v_version,
          'declarations', '["kug200bJobSeeking","kug200bProfileAccess"]'::jsonb), false);
      -- Declaration 17 as written, one record in force (Q185), by the dates on the papers and of
      -- the withdrawals, never by the order of acceptance: the paper is in force only if signed
      -- after every withdrawal received and not before a usable paper in force.
      v_in_force := p_signed_on > coalesce((SELECT pg_catalog.max(w.received_on)
          FROM public.kug200b_withdrawal w WHERE w.participation_id = d.participation_id),
        '-infinity'::date)
        AND NOT EXISTS (SELECT FROM public.consent_record x
          JOIN public.document s ON s.id = x.document_id
          WHERE x.participation_id = d.participation_id AND x.purpose = 'kug200b_profile_access'
            AND x.ended_at IS NULL AND x.given_on > p_signed_on AND s.deleted_at IS NULL
            AND s.quarantined_at IS NULL AND s.invalidated_by_correction IS NULL);
      IF v_in_force THEN
        FOR c IN SELECT * FROM public.consent_record
          WHERE participation_id = d.participation_id AND purpose = 'kug200b_profile_access'
            AND ended_at IS NULL ORDER BY id FOR UPDATE LOOP
          UPDATE public.consent_record SET ended_at = now(), end_reason = 'superseded'
          WHERE id = c.id;
          PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_ended',
            p_context, NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object(
              'consentId', c.id, 'purpose', c.purpose, 'source', c.source), false);
        END LOOP;
      END IF;
      v_consent := pg_catalog.gen_random_uuid();
      v_text := 'kug200b-' || v_version || ':v1';
      INSERT INTO public.consent_record (id, project_id, participation_id, purpose, source,
        text_version, language, actor_type, actor_staff_user_id, given_on, document_id, ended_at,
        end_reason)
      VALUES (v_consent, d.project_id, d.participation_id, 'kug200b_profile_access', 'paper_form',
        v_text, 'de', 'user', (p_context).staff_user_id, p_signed_on, d.id,
        CASE WHEN NOT v_in_force THEN now() END,
        CASE WHEN NOT v_in_force THEN 'superseded'::public.consent_end_reason END);
      PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_given',
        p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object(
          'consentId', v_consent, 'purpose', 'kug200b_profile_access', 'textVersion', v_text,
          'language', 'de', 'source', 'paper_form'), false);
      -- An older paper is kept as history only, ended at once.
      IF NOT v_in_force THEN
        PERFORM public.write_audit_event(d.project_id, d.participation_id, 'consent_ended',
          p_context, NULL, NULL, NULL, 'superseded', NULL, pg_catalog.jsonb_build_object(
            'consentId', v_consent, 'purpose', 'kug200b_profile_access', 'source', 'paper_form'),
          false);
      END IF;
    ELSE
      IF p_declarations ->> 'kind' = 'as_printed' THEN
        v_choice := g.jobboerse_choice::text;
        v_contact := CASE g.ba_contact_consent WHEN true THEN 'yes' WHEN false THEN 'no' END;
      ELSE
        v_choice := p_declarations ->> 'jobboerseChoice';
        v_contact := CASE (p_declarations ->> 'baContactConsent')::boolean
          WHEN true THEN 'yes' WHEN false THEN 'no' END;
      END IF;
      INSERT INTO public.signed_declaration (id, project_id, participation_id, document_id,
        form_code, form_version, declaration, value, signed_on, recorded_by)
      VALUES
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id,
          public.scan_form(d.type), v_version, 'jobboerseChoice', v_choice, v_signed_on,
          (p_context).staff_user_id),
        (pg_catalog.gen_random_uuid(), d.project_id, d.participation_id, d.id,
          public.scan_form(d.type), v_version, 'baContactConsent', v_contact, v_signed_on,
          (p_context).staff_user_id);
      PERFORM public.write_audit_event(d.project_id, d.participation_id,
        'signed_declaration_recorded', p_context, NULL, NULL, NULL, NULL, NULL,
        pg_catalog.jsonb_build_object('documentId', d.id, 'formCode', public.scan_form(d.type),
          'formVersion', v_version,
          'declarations', '["jobboerseChoice","baContactConsent"]'::jsonb), false);
    END IF;
  ELSE
    UPDATE public.document SET review_state = p_decision, review_reason = p_reason,
      reviewed_by = (p_context).staff_user_id, reviewed_at = now()
    WHERE id = d.id;
  END IF;
  IF d.type = 'dsv_signed_scan' AND v_accept THEN
    PERFORM public.sync_dsv_contract(d.dsv_offer_id);
  END IF;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_reviewed',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('documentId', d.id,
      'documentType', d.type, 'decision', p_decision, 'origin', d.scan_origin,
      'formVersion', CASE WHEN v_accept THEN v_version END,
      'termsConfirmed', CASE WHEN d.type = 'dsv_signed_scan' AND v_accept THEN coalesce((p_dsv->>'termsConfirmed')::boolean,false) END,
      'signatureKinds', CASE WHEN d.type IN ('dsv_signed_scan', 'dsv_cancellation') AND v_accept THEN (SELECT coalesce(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM jsonb_each(p_dsv->'signatures')) END)), false);
END $function$;

ALTER FUNCTION public.review_document(public.audit_context,uuid,public.document_review_state,public.document_review_reason,date,date,text[],text,jsonb,jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.review_document(public.audit_context,uuid,public.document_review_state,public.document_review_reason,date,date,text[],text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_document(public.audit_context,uuid,public.document_review_state,public.document_review_reason,date,date,text[],text,jsonb,jsonb) TO transfer_app;
