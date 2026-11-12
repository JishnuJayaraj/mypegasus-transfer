CREATE OR REPLACE FUNCTION public.retention_working_copies(p_run uuid)
 RETURNS TABLE(document_id uuid, participation_id uuid, generated_on date, superseded_on date, scan_accepted_on date, closed_on date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN QUERY SELECT d.id, p.id, (g.generated_at AT TIME ZONE 'Europe/Berlin')::date,
    (SELECT (min(n.generated_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.form_generation n
     WHERE n.participation_id = g.participation_id AND n.form_code = g.form_code
       AND (n.generated_at, n.id) > (g.generated_at, g.id)),
    (SELECT (min(s.reviewed_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.document s
     WHERE s.generation_document_id = d.id AND s.review_state = 'accepted'),
    CASE WHEN p.status::text IN ('withdrawn','ta_completed','exited') THEN
      (SELECT (max(e.occurred_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.audit_event e
       WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status') END
  FROM public.document d JOIN public.form_generation g ON g.document_id = d.id
  JOIN public.participation p ON p.id = d.participation_id
  WHERE d.retention_class = 'form_working_copy' AND d.deleted_at IS NULL ORDER BY d.id;
END $function$;

ALTER FUNCTION public.retention_working_copies(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_working_copies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_working_copies(uuid) TO transfer_retention;
