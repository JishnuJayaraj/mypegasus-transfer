CREATE OR REPLACE FUNCTION public.exception_evidence_fingerprint(p_participation_id uuid, p_kind public.exception_evidence_kind, p_digests text[], p_agentur_key text, p_reference text, p_confirmed_on date)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT 'sha256:v1:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.array_to_string(
      ARRAY['profiling-exception-evidence:v1', p_participation_id::text, p_kind::text]
      || CASE p_kind::text
        WHEN 'documents' THEN ARRAY(SELECT u.d FROM (SELECT DISTINCT d
          FROM pg_catalog.unnest(p_digests) d) u ORDER BY u.d COLLATE "C")
        ELSE ARRAY['agenturKey=' || p_agentur_key,
          'confirmedOn=' || pg_catalog.to_char(p_confirmed_on, 'YYYY-MM-DD'),
          'reference=' || p_reference] END,
      E'\n'), 'UTF8')), 'hex')
$function$;

ALTER FUNCTION public.exception_evidence_fingerprint(uuid,public.exception_evidence_kind,text[],text,text,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.exception_evidence_fingerprint(uuid,public.exception_evidence_kind,text[],text,text,date) FROM PUBLIC;
