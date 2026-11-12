CREATE OR REPLACE FUNCTION public.retention_known_objects(p_run uuid, p_document_ids uuid[])
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN ARRAY(SELECT id FROM public.document WHERE id = ANY (coalesce(p_document_ids, '{}')));
END $function$;

ALTER FUNCTION public.retention_known_objects(uuid,uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_known_objects(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_known_objects(uuid,uuid[]) TO transfer_retention;
