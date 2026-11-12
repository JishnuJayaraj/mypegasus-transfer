CREATE OR REPLACE FUNCTION public.dsv_cancellation_facts(p_ids uuid[])
 RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, valid_on date, recorded_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT d.participation_id, d.id, o.id, greatest(s.signed_on, c.signed_on, t.signed_on),
   greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at)
 FROM public.document d
 JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
   AND o.ended_as = 'signed'
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
   AND s.superseded_by IS NULL
 JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
   AND c.superseded_by IS NULL
 JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
   AND t.superseded_by IS NULL
 WHERE d.participation_id = ANY(p_ids) AND d.type = 'dsv_cancellation'
 AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL
$function$;

ALTER FUNCTION public.dsv_cancellation_facts(uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.dsv_cancellation_facts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dsv_cancellation_facts(uuid[]) TO transfer_app;
