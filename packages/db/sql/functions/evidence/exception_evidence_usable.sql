CREATE OR REPLACE FUNCTION public.exception_evidence_usable(p_record_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce((
    SELECT CASE r.kind::text WHEN 'ba_confirmation' THEN true
      WHEN 'legacy_unverified' THEN false ELSE NOT EXISTS (
      SELECT FROM pg_catalog.unnest(r.document_ids) i
      LEFT JOIN public.document d ON d.id = i AND d.participation_id = r.participation_id
      WHERE d.id IS NULL OR d.deleted_at IS NOT NULL OR d.review_state::text <> 'accepted'
        OR d.quarantined_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL) END
    FROM public.profiling_exception_evidence_record r WHERE r.id = p_record_id), false)
$function$;

ALTER FUNCTION public.exception_evidence_usable(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.exception_evidence_usable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exception_evidence_usable(uuid) TO transfer_app;
