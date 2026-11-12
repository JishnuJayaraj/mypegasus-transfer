CREATE OR REPLACE FUNCTION public.normalise_correction_source(p_source text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_source IS NULL
      OR pg_catalog.replace(p_source, E'\t', ' ') ~ '[[:cntrl:]]' THEN NULL
    ELSE NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.normalize(p_source, 'NFC'),
      '\s+', ' ', 'g')), '') END
$function$;

ALTER FUNCTION public.normalise_correction_source(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.normalise_correction_source(text) FROM PUBLIC;
