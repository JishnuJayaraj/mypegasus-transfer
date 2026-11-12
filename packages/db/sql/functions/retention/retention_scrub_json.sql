CREATE OR REPLACE FUNCTION public.retention_scrub_json(p_value jsonb, p_owned boolean, p_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind text := pg_catalog.jsonb_typeof(p_value);
  v_item record;
  v_result jsonb;
  v_text text;
  v_new uuid;
  v_record_keys constant text[] := ARRAY[
    'acknowledgementId','activationCodeId','amendmentId','assignmentId','assistedModeId',
    'basisBookingId','bookingId','challengeId','channelId','channelIds','clarificationId',
    'consentId','correctionId','documentId','evidenceRecordId','followUpOf','holdId',
    'noticeDeliveryId','profilingExceptionRequestId','reconciliationId','registrationId',
    'reminderId','reviewedEventId','sessionId','statusChangeId','submissionId','retainedFrom',
    'withdrawalId','taskId'];
BEGIN
  IF v_kind = 'object' THEN
    v_result := '{}'::jsonb;
    FOR v_item IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
      v_result := v_result || pg_catalog.jsonb_build_object(v_item.key,
        public.retention_scrub_json(v_item.value, p_owned, v_item.key));
    END LOOP;
    RETURN v_result;
  ELSIF v_kind = 'array' THEN
    SELECT coalesce(pg_catalog.jsonb_agg(public.retention_scrub_json(value, p_owned, p_key) ORDER BY ord), '[]'::jsonb)
    INTO v_result FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ord);
    RETURN v_result;
  ELSIF v_kind = 'string' THEN
    v_text := p_value #>> '{}';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT replacement INTO v_new FROM pg_temp.erasure_id_map WHERE original = v_text::uuid;
      IF v_new IS NULL AND p_owned AND p_key = ANY(v_record_keys)
         AND NOT EXISTS (SELECT FROM pg_temp.erasure_kept_ids WHERE id = v_text::uuid)
         AND NOT (p_key IN ('statusChangeId', 'reviewedEventId')
           AND EXISTS (SELECT FROM public.audit_event WHERE id = v_text::uuid)) THEN
        INSERT INTO pg_temp.erasure_id_map(original, replacement)
          VALUES (v_text::uuid, pg_catalog.gen_random_uuid())
          ON CONFLICT (original) DO UPDATE SET original = EXCLUDED.original RETURNING replacement INTO v_new;
      END IF;
      IF v_new IS NOT NULL THEN RETURN pg_catalog.to_jsonb(v_new::text); END IF;
    END IF;
    RETURN pg_catalog.to_jsonb(public.retention_scrub_text(v_text));
  END IF;
  RETURN p_value;
END $function$;

ALTER FUNCTION public.retention_scrub_json(jsonb,boolean,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_scrub_json(jsonb,boolean,text) FROM PUBLIC;
