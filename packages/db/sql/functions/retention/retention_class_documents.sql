CREATE OR REPLACE FUNCTION public.retention_class_documents(p_run uuid, p_participation_id uuid, p_class text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  IF p_class IS DISTINCT FROM 'personnel_file' AND p_class IS DISTINCT FROM 'health_record' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  RETURN ARRAY(SELECT d.id FROM public.document d
    WHERE d.participation_id = p_participation_id AND d.retention_class = p_class
      AND d.deleted_at IS NULL
      AND NOT EXISTS (SELECT FROM public.legal_hold h WHERE h.participation_id = p_participation_id
        AND h.released_at IS NULL AND (d.id = ANY (h.document_ids) OR p_class = ANY (h.classes)))
    ORDER BY d.id);
END $function$;

ALTER FUNCTION public.retention_class_documents(uuid,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_class_documents(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_class_documents(uuid,uuid,text) TO transfer_retention;
