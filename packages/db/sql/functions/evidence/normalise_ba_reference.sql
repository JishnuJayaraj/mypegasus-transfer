CREATE OR REPLACE FUNCTION public.normalise_ba_reference(p_reference text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_reference ~ '[[:cntrl:]]' THEN NULL ELSE NULLIF(
    pg_catalog.normalize(pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.normalize(p_reference, 'NFC'), ' {2,}', ' ', 'g'), ' ') COLLATE "und-x-icu"),
      'NFC'), '') END
$function$;

ALTER FUNCTION public.normalise_ba_reference(text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.normalise_ba_reference(text) FROM PUBLIC;
