CREATE OR REPLACE FUNCTION public.record_declaration_withdrawal(p_context public.audit_context, p_participation_id uuid, p_id uuid, p_consent_id uuid, p_received_on date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  c public.consent_record;
BEGIN
  IF p_participation_id IS NULL OR p_id IS NULL OR p_consent_id IS NULL
     OR p_received_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, false);
  SELECT * INTO c FROM public.consent_record
  WHERE id = p_consent_id AND participation_id = r.id AND purpose = 'kug200b_profile_access'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consent_not_found';
  END IF;
  IF c.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'consent_ended';
  END IF;
  IF p_received_on > public.berlin_today() THEN
    RAISE EXCEPTION 'received_on_in_future';
  END IF;
  IF p_received_on < c.given_on THEN
    RAISE EXCEPTION 'received_before_consent';
  END IF;
  UPDATE public.consent_record SET ended_at = now(), end_reason = 'revoked' WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'consent_ended', p_context, NULL, NULL,
    NULL, 'revoked', NULL, pg_catalog.jsonb_build_object('consentId', c.id, 'purpose',
      c.purpose, 'source', c.source), false);
  INSERT INTO public.kug200b_withdrawal (id, project_id, participation_id, consent_id,
    received_on, recorded_by)
  VALUES (p_id, r.project_id, r.id, c.id, p_received_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'declaration_withdrawal_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('withdrawalId', p_id,
      'consentId', c.id, 'receivedOn', pg_catalog.to_char(p_received_on, 'YYYY-MM-DD')), false);
  RETURN p_id;
END $function$;

ALTER FUNCTION public.record_declaration_withdrawal(public.audit_context,uuid,uuid,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_declaration_withdrawal(public.audit_context,uuid,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_declaration_withdrawal(public.audit_context,uuid,uuid,uuid,date) TO transfer_app;
