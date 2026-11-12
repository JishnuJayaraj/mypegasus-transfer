CREATE OR REPLACE FUNCTION public.form_person_valid(p_person jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.jsonb_typeof(p_person) = 'object'
    AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_person) k ORDER BY k)
      = '{birthDate,city,country,firstName,lastName,mobile,phone,postalCode,privateEmail,street,tgEnd,tgStart}'::text[]
    AND NOT EXISTS (
      SELECT FROM pg_catalog.jsonb_each(p_person) e(k, v)
      WHERE pg_catalog.jsonb_typeof(v) NOT IN ('string', 'null')), false)
$function$;

ALTER FUNCTION public.form_person_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.form_person_valid(jsonb) FROM PUBLIC;
