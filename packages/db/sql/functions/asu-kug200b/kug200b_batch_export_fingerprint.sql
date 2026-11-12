CREATE OR REPLACE FUNCTION public.kug200b_batch_export_fingerprint(p_batch public.kug200b_batch, p_kind text, p_organisation_sha256 text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 'kug200b-batch-export:v1', 'kind', p_kind, 'channel', p_batch.channel,
    'artifact', p_batch.artifact, 'organisation', p_organisation_sha256,
    'sources', public.kug200b_batch_export_sources(p_batch, p_kind))::text, 'UTF8')), 'hex')
$function$;

ALTER FUNCTION public.kug200b_batch_export_fingerprint(public.kug200b_batch,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_export_fingerprint(public.kug200b_batch,text,text) FROM PUBLIC;
