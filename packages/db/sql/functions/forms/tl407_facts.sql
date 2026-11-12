CREATE OR REPLACE FUNCTION public.tl407_facts(p_participation_ids uuid[])
 RETURNS TABLE(participation_id uuid, tl407_signed_on date, tl407_recorded_at timestamp with time zone, profiling_done_on date, profiling_done_recorded_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  WITH evidence AS (
    SELECT d.participation_id, greatest(d.signed_on, d.countersigned_on) AS valid_on,
      greatest(d.reviewed_at, coalesce(d.quarantine_lifted_at, d.reviewed_at)) AS recorded_at
    FROM public.document d
    WHERE d.participation_id = ANY (p_participation_ids) AND d.type = 'tl407_signed_scan'
      AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
      AND d.invalidated_by_correction IS NULL
  ), scan AS (
    SELECT DISTINCT ON (e.participation_id) e.participation_id, e.valid_on, e.recorded_at
    FROM evidence e
    ORDER BY e.participation_id, e.valid_on, e.recorded_at
  ), support AS (
    -- The scans that support the recorded completion date: signed by it.
    SELECT e.participation_id, pg_catalog.min(e.recorded_at) AS recorded_at
    FROM evidence e
    JOIN public.participation p ON p.id = e.participation_id
    WHERE e.valid_on <= p.profiling_done_on
    GROUP BY e.participation_id
  )
  SELECT s.participation_id, s.valid_on, s.recorded_at,
    CASE WHEN u.recorded_at IS NOT NULL THEN p.profiling_done_on END,
    CASE WHEN u.recorded_at IS NOT NULL THEN greatest(u.recorded_at, (
      SELECT pg_catalog.max(a.occurred_at) FROM public.audit_event a
      WHERE a.participation_id = p.id AND a.event_type = 'status_changed'
        AND a.field = 'profiling_status' AND a.to_value = 'profiling_done'), (
      SELECT pg_catalog.max(c.decided_at) FROM public.evidence_correction c
      WHERE c.participation_id = p.id AND c.target_kind::text = 'field'
        AND c.field_key = 'profilingDoneOn' AND c.status::text = 'approved')) END
  FROM scan s
  JOIN public.participation p ON p.id = s.participation_id
  LEFT JOIN support u ON u.participation_id = s.participation_id
$function$;

ALTER FUNCTION public.tl407_facts(uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.tl407_facts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tl407_facts(uuid[]) TO transfer_app;
