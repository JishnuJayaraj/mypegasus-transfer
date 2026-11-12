CREATE OR REPLACE FUNCTION public.iso_date_valid(v jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN pg_catalog.jsonb_typeof(v) = 'string' AND v #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND pg_catalog.to_char((v #>> '{}')::date, 'YYYY-MM-DD') = v #>> '{}';
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $function$;

ALTER FUNCTION public.iso_date_valid(jsonb) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.iso_date_valid(jsonb) FROM PUBLIC;
