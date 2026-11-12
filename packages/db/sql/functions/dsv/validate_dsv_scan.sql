CREATE OR REPLACE FUNCTION public.validate_dsv_scan(p_signatures jsonb, p_received_on date)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE item record;
BEGIN
 IF p_received_on IS NULL OR p_signatures IS NULL OR jsonb_typeof(p_signatures) <> 'object' THEN RAISE EXCEPTION 'invalid_argument'; END IF;
 IF p_received_on > public.berlin_today() THEN RAISE EXCEPTION 'received_in_future'; END IF;
 FOR item IN SELECT * FROM jsonb_each_text(p_signatures) LOOP
  IF item.key NOT IN ('participant','customer','transfergesellschaft') OR item.value IS NULL OR item.value !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF item.value::date > public.berlin_today() THEN RAISE EXCEPTION 'signature_in_future'; END IF;
 END LOOP;
 IF p_received_on < (p_signatures->>'participant')::date THEN RAISE EXCEPTION 'received_before_signature'; END IF;
END $function$;

ALTER FUNCTION public.validate_dsv_scan(jsonb,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.validate_dsv_scan(jsonb,date) FROM PUBLIC;
