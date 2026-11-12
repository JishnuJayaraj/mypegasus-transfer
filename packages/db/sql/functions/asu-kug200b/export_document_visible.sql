CREATE OR REPLACE FUNCTION public.export_document_visible(p_document public.document, p_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(p_document.type::text = 'kug200b_form' AND p_document.deleted_at IS NULL
    AND public.document_staff_roles(p_document.participation_id, p_staff_user_id)
      && (SELECT t.open_roles FROM public.document_type_policy t
          WHERE t.type = p_document.type AND t.catalog_version = p_document.catalog_version),
    false)
$function$;

ALTER FUNCTION public.export_document_visible(public.document,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.export_document_visible(public.document,uuid) FROM PUBLIC;
