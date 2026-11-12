CREATE OR REPLACE FUNCTION public.retention_scrub_text(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_map record; v_result text := p_value;
BEGIN
  FOR v_map IN SELECT original, replacement FROM pg_temp.erasure_id_map LOOP
    v_result := pg_catalog.regexp_replace(v_result, v_map.original::text, v_map.replacement::text, 'gi');
  END LOOP;
  RETURN v_result;
END $function$;

ALTER FUNCTION public.retention_scrub_text(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_scrub_text(text) FROM PUBLIC;
