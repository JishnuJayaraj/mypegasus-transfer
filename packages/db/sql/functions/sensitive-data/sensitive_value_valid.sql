CREATE OR REPLACE FUNCTION public.sensitive_value_valid(p_field text, v jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF v IS NULL OR v = 'null'::jsonb THEN RETURN true; END IF;
  RETURN CASE p_field
    WHEN 'pensionInsuranceNumber' THEN pg_catalog.jsonb_typeof(v) = 'string'
      AND v #>> '{}' ~ '^[0-9]{8}[A-Z][0-9]{3}$'
    WHEN 'nationality' THEN v = '{"kind": "german"}'::jsonb OR (
      pg_catalog.jsonb_typeof(v) = 'object' AND v ->> 'kind' = 'other'
      AND v ->> 'country' ~ '^[A-Z]{2}$' AND v ->> 'country' <> 'DE'
      AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v)) = 2)
    WHEN 'entryToGermanyDate' THEN pg_catalog.jsonb_typeof(v) = 'string'
      AND v #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND pg_catalog.to_char((v #>> '{}')::date, 'YYYY-MM-DD') = v #>> '{}'
    WHEN 'residenceStatus' THEN v #>> '{}' IN ('blue_card', 'residence_permit', 'visa',
      'settlement_permit', 'permission_to_reside', 'toleration')
      AND pg_catalog.jsonb_typeof(v) = 'string'
    WHEN 'buergergeld' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    WHEN 'healthRestrictions' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    WHEN 'severeDisability' THEN pg_catalog.jsonb_typeof(v) = 'boolean'
    ELSE false
  END;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $function$;

ALTER FUNCTION public.sensitive_value_valid(text,jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.sensitive_value_valid(text,jsonb) FROM PUBLIC;
