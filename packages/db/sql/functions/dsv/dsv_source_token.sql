CREATE OR REPLACE FUNCTION public.dsv_source_token(p_participation_id uuid, p_organisation_sha256 text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.array_to_string(
    ARRAY['dsv-sources:v1'] || ARRAY(
      SELECT v.key || '=' || coalesce(pg_catalog.to_jsonb(v.value)::text, 'null')
      FROM (VALUES
        (1, 'templateVersion', pj.dsv_template_version),
        (2, 'firstName', fp ->> 'firstName'),
        (3, 'lastName', fp ->> 'lastName'),
        (4, 'birthDate', fp ->> 'birthDate'),
        (5, 'street', fp ->> 'street'),
        (6, 'postalCode', fp ->> 'postalCode'),
        (7, 'city', fp ->> 'city'),
        (8, 'country', fp ->> 'country'),
        (9, 'tgStart', fp ->> 'tgStart'),
        (10, 'tgEnd', fp ->> 'tgEnd'),
        (11, 'entryWaveId', p.entry_wave_id::text),
        (12, 'customerName', pj.customer_name),
        (13, 'organisationSha256', p_organisation_sha256)) v(n, key, value)
      ORDER BY v.n),
    E'\n'), 'UTF8')), 'hex')
  FROM public.participation p
  JOIN public.project pj ON pj.id = p.project_id
  CROSS JOIN LATERAL public.form_person(p.id) fp
  WHERE p.id = p_participation_id
$function$;

ALTER FUNCTION public.dsv_source_token(uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.dsv_source_token(uuid,text) FROM PUBLIC;
