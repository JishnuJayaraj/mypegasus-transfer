CREATE OR REPLACE FUNCTION public.retention_delete_class(p_run uuid, p_participation_id uuid, p_class text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  p public.participation;
  v_classes text[];
  v_kinds text[];
  v_docs uuid[];
  v_deleted integer := 0;
  v_kept integer := 0;
  n integer;
BEGIN
  IF p_class IS DISTINCT FROM 'personnel_file' AND p_class IS DISTINCT FROM 'health_record' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  p := public.lock_participation(p_participation_id);
  IF p.status::text NOT IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_not_closed';
  END IF;
  IF p.evidence_set_since IS NOT NULL THEN RAISE EXCEPTION 'evidence_set_phase'; END IF;
  SELECT coalesce(array_agg(DISTINCT c), '{}') INTO v_classes
  FROM public.legal_hold h, unnest(h.classes) c
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT k), '{}') INTO v_kinds
  FROM public.legal_hold h, unnest(h.record_kinds) k
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT d), '{}') INTO v_docs
  FROM public.legal_hold h, unnest(h.document_ids) d
  WHERE h.participation_id = p.id AND h.released_at IS NULL;
  IF p_class = ANY (v_classes) THEN
    RETURN pg_catalog.jsonb_build_object('deleted', 0, 'kept', 1, 'held', true);
  END IF;
  BEGIN
    IF p_class = 'health_record' THEN
      IF NOT 'participant_health_data' = ANY (v_kinds) THEN
        DELETE FROM public.participant_health_data WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling_health_assessment' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling_health_assessment WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
    ELSE
      IF NOT 'participant_reminder' = ANY (v_kinds) THEN
        DELETE FROM public.participant_reminder WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'appointment_booking' = ANY (v_kinds) THEN
        DELETE FROM public.appointment_booking b WHERE b.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.booking_id = b.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_channel' = ANY (v_kinds) THEN
        DELETE FROM public.participant_channel c WHERE c.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.channel_id = c.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'consent_record' = ANY (v_kinds) THEN
        DELETE FROM public.consent_record c WHERE c.participation_id = p.id
          AND NOT EXISTS (SELECT FROM public.participant_reminder m WHERE m.consent_id = c.id)
          AND NOT EXISTS (SELECT FROM public.participant_channel m WHERE m.consent_id = c.id)
          AND NOT EXISTS (SELECT FROM public.kug200b_withdrawal w WHERE w.consent_id = c.id);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_details' = ANY (v_kinds) THEN
        DELETE FROM public.participant_details WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profile' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profile WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling_assessment' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling_assessment WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'participant_profiling' = ANY (v_kinds) THEN
        DELETE FROM public.participant_profiling WHERE participation_id = p.id;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      DELETE FROM public.participant_residence_social_data WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.self_service_notice_acknowledgement WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.privacy_notice_delivery WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      DELETE FROM public.participant_account WHERE participation_id = p.id;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      IF NOT 'dsv_scan_signature' = ANY (v_kinds) THEN
        DELETE FROM public.dsv_scan_signature s WHERE s.participation_id = p.id
          AND NOT s.document_id = ANY (v_docs);
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
      IF NOT 'dsv_contract' = ANY (v_kinds) THEN
        UPDATE public.dsv_contract SET original_location = NULL
        WHERE participation_id = p.id AND original_location IS NOT NULL;
        GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
      END IF;
    END IF;
    UPDATE public.document SET deleted_at = pg_catalog.now(), deleted_by = 'system',
      file_name = NULL, purged_at = pg_catalog.now()
    WHERE participation_id = p.id AND retention_class = p_class AND deleted_at IS NULL
      AND NOT id = ANY (v_docs);
    GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
    v_kept := pg_catalog.cardinality(v_kinds) + pg_catalog.cardinality(v_docs);
    PERFORM public.write_audit_event(p.project_id, p.id, 'retention_applied',
      ROW('system', NULL, NULL, 'retention', NULL, NULL, p_run::text)::public.audit_context,
      NULL, NULL, NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('retentionClass', p_class, 'deleted', v_deleted,
        'kept', v_kept), false);
    IF r.dry_run THEN RAISE EXCEPTION 'retention_dry_run'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'retention_dry_run' THEN RAISE; END IF;
  END;
  RETURN pg_catalog.jsonb_build_object('deleted', v_deleted, 'kept', v_kept, 'held', false);
END $function$;

ALTER FUNCTION public.retention_delete_class(uuid,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_delete_class(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_delete_class(uuid,uuid,text) TO transfer_retention;
