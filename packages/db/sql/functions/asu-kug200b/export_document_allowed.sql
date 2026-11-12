CREATE OR REPLACE FUNCTION public.export_document_allowed(p_document public.document, p_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT public.export_document_visible(p_document, p_staff_user_id)
    AND p_document.quarantined_at IS NULL AND p_document.invalidated_by_correction IS NULL
$function$;

ALTER FUNCTION public.export_document_allowed(public.document,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.export_document_allowed(public.document,uuid) FROM PUBLIC;
