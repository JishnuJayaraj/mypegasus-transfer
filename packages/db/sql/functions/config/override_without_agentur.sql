CREATE OR REPLACE FUNCTION public.override_without_agentur(p_content jsonb, p_agentur_key text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN r -> 'agenturSettings' = '{}'::jsonb THEN r - 'agenturSettings' ELSE r END
  FROM (SELECT pg_catalog.jsonb_delete_path(p_content, ARRAY['agenturSettings', p_agentur_key]) AS r) s
$function$;

ALTER FUNCTION public.override_without_agentur(jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.override_without_agentur(jsonb,text) FROM PUBLIC;
