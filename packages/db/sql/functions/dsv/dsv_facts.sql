CREATE OR REPLACE FUNCTION public.dsv_facts(p_ids uuid[])
 RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, signed_on date, recorded_at timestamp with time zone, customer_signed_on date, tg_signed_on date, executed_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT d.participation_id, d.id, o.id, s.signed_on,
 greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at),
 c.signed_on, t.signed_on,
 CASE WHEN o.ended_as = 'signed' AND c.signed_on IS NOT NULL AND t.signed_on IS NOT NULL
   AND s.signed_on = (SELECT pg_catalog.min(x.signed_on) FROM public.dsv_scan_signature x
     JOIN public.document y ON y.id = x.document_id
     WHERE y.dsv_offer_id = o.id AND y.type = 'dsv_signed_scan' AND y.review_state = 'accepted'
       AND y.deleted_at IS NULL AND x.kind = 'participant' AND x.superseded_by IS NULL)
 THEN greatest(s.signed_on, c.signed_on, t.signed_on) END
 FROM public.document d JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
   AND s.superseded_by IS NULL
 LEFT JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
   AND c.superseded_by IS NULL
 LEFT JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
   AND t.superseded_by IS NULL
 WHERE d.participation_id = ANY(p_ids) AND (o.ended_as IS NULL OR o.ended_as = 'signed')
 AND d.type = 'dsv_signed_scan' AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL AND d.dsv_received_on >= s.signed_on
$function$;

ALTER FUNCTION public.dsv_facts(uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.dsv_facts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dsv_facts(uuid[]) TO transfer_app;
