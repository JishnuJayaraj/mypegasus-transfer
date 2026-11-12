CREATE OR REPLACE FUNCTION public.record_document_purged(p_document_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT FROM public.document WHERE id = p_document_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'document_not_deleted';
  END IF;
  UPDATE public.document SET purged_at = now() WHERE id = p_document_id AND purged_at IS NULL;
  RETURN FOUND;
END $function$;

ALTER FUNCTION public.record_document_purged(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_document_purged(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_document_purged(uuid) TO transfer_app;
