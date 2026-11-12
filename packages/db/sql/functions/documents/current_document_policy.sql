CREATE OR REPLACE FUNCTION public.current_document_policy(p_type public.document_type)
 RETURNS public.document_type_policy
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT * FROM public.document_type_policy WHERE type = p_type
  ORDER BY catalog_version DESC LIMIT 1
$function$;

ALTER FUNCTION public.current_document_policy(public.document_type) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.current_document_policy(public.document_type) FROM PUBLIC;
