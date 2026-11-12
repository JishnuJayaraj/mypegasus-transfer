CREATE OR REPLACE FUNCTION public.retention_participations(p_run uuid)
 RETURNS TABLE(participation_id uuid, status text, closed_on date, withdrawn_on date, exit_date date, entered_tg boolean, dsv_fully_executed boolean, funded110 text, evidence_set_since timestamp with time zone, held_classes text[], held_record_kinds text[], held_documents integer, classes_left text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN QUERY
  SELECT p.id, p.status::text,
    (SELECT (max(e.occurred_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.audit_event e
     WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status'),
    p.withdrawn_on, p.exit_date, p.tg_entry_date IS NOT NULL,
    EXISTS (SELECT FROM public.dsv_contract c WHERE c.participation_id = p.id
      AND c.fully_executed_on IS NOT NULL),
    p.funded110::text, p.evidence_set_since,
    coalesce((SELECT array_agg(DISTINCT x) FROM public.legal_hold h, unnest(h.classes) x
      WHERE h.participation_id = p.id AND h.released_at IS NULL), '{}'),
    coalesce((SELECT array_agg(DISTINCT x) FROM public.legal_hold h, unnest(h.record_kinds) x
      WHERE h.participation_id = p.id AND h.released_at IS NULL), '{}'),
    coalesce((SELECT sum(cardinality(h.document_ids))::integer FROM public.legal_hold h
      WHERE h.participation_id = p.id AND h.released_at IS NULL), 0),
    public.retention_classes_left(p.id)
  FROM public.participation p
  WHERE p.status::text IN ('withdrawn', 'ta_completed', 'exited')
  ORDER BY p.id;
END $function$;

ALTER FUNCTION public.retention_participations(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_participations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_participations(uuid) TO transfer_retention;
