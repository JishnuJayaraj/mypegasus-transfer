CREATE OR REPLACE FUNCTION public.record_asu_registration(p_context public.audit_context, p_participation_id uuid, p_id uuid, p_registered_on date, p_route_version integer, p_customer_number text DEFAULT NULL::text, p_attestation_source public.asu_attestation_source DEFAULT NULL::public.asu_attestation_source, p_key text DEFAULT NULL::text, p_key_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id
      AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
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
END $function$;

ALTER FUNCTION public.record_asu_registration(public.audit_context,uuid,uuid,date,integer,text,public.asu_attestation_source,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_asu_registration(public.audit_context,uuid,uuid,date,integer,text,public.asu_attestation_source,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_asu_registration(public.audit_context,uuid,uuid,date,integer,text,public.asu_attestation_source,text,text) TO transfer_app;
