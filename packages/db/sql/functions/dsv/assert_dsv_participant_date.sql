CREATE OR REPLACE FUNCTION public.assert_dsv_participant_date(p_offer_id uuid, p_participant text, p_exclude uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_participant IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT FROM public.document d
      JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
        AND s.superseded_by IS NULL
      WHERE d.dsv_offer_id = p_offer_id AND d.type = 'dsv_signed_scan'
        AND d.review_state = 'accepted' AND d.deleted_at IS NULL
        AND d.id IS DISTINCT FROM p_exclude AND s.signed_on <> p_participant::date) THEN
    RAISE EXCEPTION 'signature_date_mismatch';
  END IF;
END $function$;

ALTER FUNCTION public.assert_dsv_participant_date(uuid,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_dsv_participant_date(uuid,text,uuid) FROM PUBLIC;
