CREATE OR REPLACE FUNCTION public.sensitive_group_fields(p_group text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE p_group
    WHEN 'ba_details' THEN
      '{pensionInsuranceNumber,nationality,entryToGermanyDate,residenceStatus,buergergeld}'::text[]
    WHEN 'health' THEN '{healthRestrictions,severeDisability}'::text[]
  END
$function$;

ALTER FUNCTION public.sensitive_group_fields(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.sensitive_group_fields(text) FROM PUBLIC;
