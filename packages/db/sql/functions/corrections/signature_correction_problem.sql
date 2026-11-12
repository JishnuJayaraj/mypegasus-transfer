CREATE OR REPLACE FUNCTION public.signature_correction_problem(p_offer_id uuid, p_paper text, p_kind text, p_corrected_on date, OUT original date, OUT problem text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_dates integer;
BEGIN
  SELECT pg_catalog.min(s.signed_on), pg_catalog.count(DISTINCT s.signed_on)
  INTO original, v_dates
  FROM public.document d
  JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = p_kind
    AND s.superseded_by IS NULL
  WHERE d.dsv_offer_id = p_offer_id AND d.type::text = p_paper AND d.review_state = 'accepted'
    AND d.deleted_at IS NULL AND d.invalidated_by_correction IS NULL;
  IF original IS NULL THEN
    problem := 'signature_not_shown';
  ELSIF v_dates > 1 THEN
    problem := 'signature_date_mismatch';
  ELSIF p_corrected_on = original THEN
    problem := 'correction_unchanged';
  ELSIF p_corrected_on > public.berlin_today() THEN
    problem := 'corrected_on_in_future';
  ELSIF p_kind = 'participant' AND EXISTS (
      SELECT FROM public.document d
      WHERE d.dsv_offer_id = p_offer_id AND d.type::text = p_paper
        AND d.review_state = 'accepted' AND d.deleted_at IS NULL
        AND d.invalidated_by_correction IS NULL AND d.dsv_received_on < p_corrected_on) THEN
    problem := 'received_before_signature';
  END IF;
END $function$;

ALTER FUNCTION public.signature_correction_problem(uuid,text,text,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.signature_correction_problem(uuid,text,text,date) FROM PUBLIC;
