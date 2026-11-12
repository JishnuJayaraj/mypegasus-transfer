CREATE OR REPLACE FUNCTION public.retention_lock_working_copy(p_run uuid, p_document_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation uuid;
BEGIN
  PERFORM public.retention_run_of(p_run);
  SELECT participation_id INTO v_participation FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.lock_participation(v_participation);
  RETURN EXISTS (SELECT FROM public.document d WHERE d.id = p_document_id
    AND d.retention_class = 'form_working_copy' AND d.deleted_at IS NULL
    AND NOT EXISTS (SELECT FROM public.legal_hold h WHERE h.participation_id = d.participation_id
      AND h.released_at IS NULL AND ('form_working_copy' = ANY(h.classes) OR d.id = ANY(h.document_ids))));
END $function$;

ALTER FUNCTION public.retention_lock_working_copy(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_lock_working_copy(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_lock_working_copy(uuid,uuid) TO transfer_retention;
