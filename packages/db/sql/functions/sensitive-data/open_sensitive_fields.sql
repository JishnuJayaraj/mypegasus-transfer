CREATE OR REPLACE FUNCTION public.open_sensitive_fields(p_participation_id uuid, p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  i public.participant_identifier_data;
  rs public.participant_residence_social_data;
  h public.participant_health_data;
BEGIN
  SELECT * INTO i FROM public.participant_identifier_data WHERE participation_id = p_participation_id;
  SELECT * INTO rs FROM public.participant_residence_social_data
  WHERE participation_id = p_participation_id;
  SELECT * INTO h FROM public.participant_health_data WHERE participation_id = p_participation_id;
  IF i.key_id <> p_key_id OR rs.key_id <> p_key_id OR h.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'pensionInsuranceNumber', public.open_sensitive_value(p_participation_id,
      'pensionInsuranceNumber', i.pension_insurance_number, p_key),
    'nationality', public.open_sensitive_value(p_participation_id, 'nationality',
      rs.nationality, p_key),
    'entryToGermanyDate', public.open_sensitive_value(p_participation_id, 'entryToGermanyDate',
      rs.entry_to_germany_date, p_key),
    'residenceStatus', public.open_sensitive_value(p_participation_id, 'residenceStatus',
      rs.residence_status, p_key),
    'buergergeld', public.open_sensitive_value(p_participation_id, 'buergergeld',
      rs.buergergeld, p_key),
    'healthRestrictions', public.open_sensitive_value(p_participation_id, 'healthRestrictions',
      h.health_restrictions, p_key),
    'severeDisability', public.open_sensitive_value(p_participation_id, 'severeDisability',
      h.severe_disability, p_key));
END $function$;

ALTER FUNCTION public.open_sensitive_fields(uuid,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.open_sensitive_fields(uuid,text,text) FROM PUBLIC;
