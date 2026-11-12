CREATE OR REPLACE FUNCTION public.tl407_evidence(p_participation_id uuid)
 RETURNS TABLE(document_id uuid, valid_on date, recorded_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT d.id, greatest(d.signed_on, d.countersigned_on),
    greatest(d.reviewed_at, coalesce(d.quarantine_lifted_at, d.reviewed_at))
  FROM public.document d
  WHERE d.participation_id = p_participation_id AND d.type = 'tl407_signed_scan'
    AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
    AND d.invalidated_by_correction IS NULL
$function$;

ALTER FUNCTION public.tl407_evidence(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.tl407_evidence(uuid) FROM PUBLIC;
