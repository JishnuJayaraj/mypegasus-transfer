CREATE OR REPLACE FUNCTION public.retention_erase_participation(p_run uuid, p_participation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  p public.participation;
  v_project uuid;
  v_trigger text;
  v_trigger_on date;
  v_entered boolean;
  v_pseudonym uuid := pg_catalog.gen_random_uuid();
  v_table text;
  v_event record;
  v_fk record;
  v_added integer;
  v_count integer;
  v_deleted integer := 0;
  v_kept integer := 0;
  v_has_hold boolean;
  v_classes text[];
  v_kinds text[];
  v_docs uuid[];
  v_files uuid[] := '{}';
  v_tables constant text[] := ARRAY[
    /*generated:erasure_tables*/
  ];
BEGIN
  SELECT project_id INTO v_project FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(v_project));
  SELECT * INTO p FROM public.participation WHERE id = p_participation_id FOR UPDATE;
  IF NOT FOUND OR p.status::text NOT IN ('withdrawn','ta_completed','exited') THEN RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb); END IF;
  IF p.funded110::text = 'unknown' THEN RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb); END IF;
  IF EXISTS (SELECT FROM public.participation q WHERE q.project_id = p.project_id AND q.funded110::text = 'unknown')
    OR EXISTS (SELECT FROM public.project pr WHERE pr.id = p.project_id AND
      ((pr.kug_final_settlement_date IS NULL AND EXISTS (SELECT FROM public.participation q WHERE q.project_id = p.project_id AND coalesce(q.erasure_entered_tg, q.tg_entry_date IS NOT NULL)))
       OR (pr.measure110_settlement_date IS NULL AND EXISTS (SELECT FROM public.participation q WHERE q.project_id = p.project_id AND q.funded110::text = 'known_yes')))) THEN
    RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb);
  END IF;
  v_entered := coalesce(p.erasure_entered_tg, p.tg_entry_date IS NOT NULL);
  v_trigger := coalesce(p.erasure_trigger, CASE WHEN p.status::text = 'exited' THEN 'exited'
    WHEN p.status::text = 'withdrawn' AND NOT v_entered AND EXISTS
      (SELECT FROM public.dsv_contract WHERE participation_id = p.id AND fully_executed_on IS NOT NULL) THEN 'closed_without_tg'
    WHEN p.status::text = 'withdrawn' AND NOT v_entered THEN 'non_signer_withdrawn' END);
  v_trigger_on := coalesce(p.erasure_trigger_on, CASE WHEN p.status::text = 'exited' THEN p.exit_date ELSE p.withdrawn_on END,
    (SELECT (max(e.occurred_at) AT TIME ZONE 'Europe/Berlin')::date FROM public.audit_event e
     WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status'));
  IF v_trigger IS NULL OR v_trigger_on IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb, 'blocked', 'trigger_unknown');
  END IF;
  SELECT EXISTS (SELECT FROM public.legal_hold WHERE participation_id = p.id AND released_at IS NULL) INTO v_has_hold;
  SELECT coalesce(array_agg(DISTINCT c), '{}') INTO v_classes
    FROM public.legal_hold h, unnest(h.classes) c WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT k), '{}') INTO v_kinds
    FROM public.legal_hold h, unnest(h.record_kinds) k WHERE h.participation_id = p.id AND h.released_at IS NULL;
  SELECT coalesce(array_agg(DISTINCT d), '{}') INTO v_docs
    FROM public.legal_hold h, unnest(h.document_ids) d WHERE h.participation_id = p.id AND h.released_at IS NULL;
  CREATE TEMP TABLE erasure_keep (table_name text NOT NULL, rowid tid NOT NULL,
    PRIMARY KEY (table_name, rowid)) ON COMMIT DROP;
  CREATE TEMP TABLE erasure_kept_ids (id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE erasure_all_ids (id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE erasure_id_map (original uuid PRIMARY KEY, replacement uuid NOT NULL UNIQUE) ON COMMIT DROP;
  INSERT INTO pg_temp.erasure_all_ids VALUES (p.id);
  IF NOT v_has_hold THEN INSERT INTO pg_temp.erasure_id_map VALUES (p.id, v_pseudonym); END IF;
  IF v_has_hold THEN
    INSERT INTO pg_temp.erasure_keep SELECT 'legal_hold', ctid FROM public.legal_hold
      WHERE participation_id = p.id AND released_at IS NULL;
    INSERT INTO pg_temp.erasure_keep SELECT 'document', ctid FROM public.document
      WHERE participation_id = p.id AND (id = ANY(v_docs) OR retention_class::text = ANY(v_classes))
      ON CONFLICT DO NOTHING;
    FOR v_table IN SELECT unnest(v_tables) LOOP
      IF v_table = ANY(v_kinds)
        OR ('personnel_file' = ANY(v_classes) AND v_table = ANY(ARRAY[
          'participant_details','participant_profile','participant_residence_social_data',
          'participant_profiling','participant_profiling_assessment','self_service_notice_acknowledgement',
          'privacy_notice_delivery','participant_account','consent_record','participant_channel',
          'dsv_scan_signature','participant_reminder','appointment_booking']))
        OR ('health_record' = ANY(v_classes) AND v_table = ANY(ARRAY[
          'participant_health_data','participant_profiling_health_assessment']))
        OR ('form_working_copy' = ANY(v_classes) AND v_table = 'form_generation') THEN
        EXECUTE pg_catalog.format('INSERT INTO pg_temp.erasure_keep SELECT %L, ctid FROM public.%I WHERE participation_id = $1 ON CONFLICT DO NOTHING', v_table, v_table) USING p.id;
      END IF;
    END LOOP;
    IF 'personnel_file' = ANY(v_classes) THEN
      INSERT INTO pg_temp.erasure_keep SELECT 'dsv_contract', ctid FROM public.dsv_contract
        WHERE participation_id = p.id AND original_location IS NOT NULL ON CONFLICT DO NOTHING;
    END IF;
    -- Keep the transitive FK parents of retained rows, not unrelated neighbours.
    LOOP
      v_added := 0;
      FOR v_fk IN
        SELECT src.relname AS source, dst.relname AS target,
          pg_catalog.string_agg(pg_catalog.format('parent_row.%I = child_row.%I', pa.attname, ca.attname), ' AND ' ORDER BY ck.ordinality) AS predicate
        FROM pg_catalog.pg_constraint fk
        JOIN pg_catalog.pg_class src ON src.oid = fk.conrelid
        JOIN pg_catalog.pg_class dst ON dst.oid = fk.confrelid
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY AS ck(child_attnum, parent_attnum, ordinality)
        JOIN pg_catalog.pg_attribute ca ON ca.attrelid = src.oid AND ca.attnum = ck.child_attnum
        JOIN pg_catalog.pg_attribute pa ON pa.attrelid = dst.oid AND pa.attnum = ck.parent_attnum
        WHERE fk.contype = 'f' AND src.relnamespace = 'public'::regnamespace
          AND dst.relnamespace = 'public'::regnamespace AND src.relname = ANY(v_tables)
          AND dst.relname = ANY(v_tables)
        GROUP BY fk.oid, src.relname, dst.relname
      LOOP
        EXECUTE pg_catalog.format('INSERT INTO pg_temp.erasure_keep SELECT %L, parent_row.ctid FROM public.%I child_row JOIN pg_temp.erasure_keep k ON k.table_name = %L AND k.rowid = child_row.ctid JOIN public.%I parent_row ON %s WHERE parent_row.participation_id = $1 ON CONFLICT DO NOTHING',
          v_fk.target, v_fk.source, v_fk.source, v_fk.target, v_fk.predicate) USING p.id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_added := v_added + v_count;
      END LOOP;
      -- The evidence record's document IDs are an array rather than foreign keys.
      INSERT INTO pg_temp.erasure_keep
        SELECT 'document', d.ctid FROM public.profiling_exception_evidence_record e
        JOIN pg_temp.erasure_keep k ON k.table_name = 'profiling_exception_evidence_record' AND k.rowid = e.ctid
        JOIN public.document d ON d.id = ANY(e.document_ids)
        WHERE e.participation_id = p.id AND d.participation_id = p.id ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_added := v_added + v_count;
      -- A portal-contact consent names its channel without an FK; keep the referenced row.
      INSERT INTO pg_temp.erasure_keep
        SELECT 'participant_channel', ch.ctid FROM public.consent_record c
        JOIN pg_temp.erasure_keep k ON k.table_name = 'consent_record' AND k.rowid = c.ctid
        JOIN public.participant_channel ch ON ch.id = c.channel_id
        WHERE c.participation_id = p.id AND ch.participation_id = p.id ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_added := v_added + v_count;
      EXIT WHEN v_added = 0;
    END LOOP;
  END IF;
  SELECT coalesce(array_agg(d.id ORDER BY d.id), '{}') INTO v_files FROM public.document d
    WHERE d.participation_id = p.id AND d.purged_at IS NULL
      AND NOT EXISTS (SELECT FROM pg_temp.erasure_keep k WHERE k.table_name = 'document' AND k.rowid = d.ctid);
  SELECT count(*)::integer + CASE WHEN v_has_hold THEN 1 ELSE 0 END INTO v_kept FROM pg_temp.erasure_keep;
  FOR v_table IN SELECT unnest(v_tables || ARRAY['audit_event']) LOOP
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = v_table AND column_name = 'id' AND udt_name = 'uuid') THEN
      EXECUTE pg_catalog.format('INSERT INTO pg_temp.erasure_all_ids SELECT id FROM public.%I WHERE participation_id = $1 ON CONFLICT DO NOTHING', v_table) USING p.id;
      IF v_table <> 'audit_event' THEN
        EXECUTE pg_catalog.format('INSERT INTO pg_temp.erasure_kept_ids SELECT t.id FROM public.%I t JOIN pg_temp.erasure_keep k ON k.table_name = %L AND k.rowid = t.ctid WHERE t.participation_id = $1 ON CONFLICT DO NOTHING', v_table, v_table) USING p.id;
      END IF;
      IF v_table <> 'audit_event' OR NOT v_has_hold THEN
        EXECUTE pg_catalog.format('INSERT INTO pg_temp.erasure_id_map SELECT t.id, pg_catalog.gen_random_uuid() FROM public.%I t WHERE t.participation_id = $1 AND NOT EXISTS (SELECT FROM pg_temp.erasure_keep k WHERE k.table_name = %L AND k.rowid = t.ctid) ON CONFLICT (original) DO NOTHING', v_table, v_table) USING p.id;
      END IF;
    END IF;
  END LOOP;
  FOR v_event IN SELECT details FROM public.audit_event WHERE participation_id = p.id ORDER BY seq LOOP
    PERFORM public.retention_scrub_json(v_event.details, true, NULL);
  END LOOP;
  INSERT INTO pg_temp.erasure_all_ids SELECT original FROM pg_temp.erasure_id_map ON CONFLICT DO NOTHING;
  -- A claimed job may already hold data outside the database. Lock its row against a new claim;
  -- if it is active, roll the erasure back and retry only after the worker has settled.
  PERFORM j.id FROM pgboss.job j WHERE EXISTS (SELECT FROM pg_temp.erasure_all_ids m
    WHERE pg_catalog.row_to_json(j)::text ILIKE '%' || m.id::text || '%') ORDER BY j.id FOR UPDATE OF j;
  IF EXISTS (SELECT FROM pgboss.job j WHERE j.state::text = 'active' AND EXISTS
    (SELECT FROM pg_temp.erasure_all_ids m WHERE pg_catalog.row_to_json(j)::text ILIKE '%' || m.id::text || '%')) THEN
    RAISE EXCEPTION 'retention_job_active';
  END IF;
  IF EXISTS (SELECT FROM pgboss.job_dependency dep JOIN pgboss.job j ON
    ((dep.parent_name = j.name AND dep.parent_id = j.id) OR (dep.child_name = j.name AND dep.child_id = j.id))
    WHERE EXISTS (SELECT FROM pg_temp.erasure_all_ids m WHERE pg_catalog.row_to_json(j)::text ILIKE '%' || m.id::text || '%')) THEN
    RAISE EXCEPTION 'retention_job_dependency';
  END IF;
  -- Purge queued payloads before their subject records; job data and singleton keys carry IDs only.
  DELETE FROM pgboss.job j WHERE EXISTS (SELECT FROM pg_temp.erasure_all_ids m
    WHERE pg_catalog.row_to_json(j)::text ILIKE '%' || m.id::text || '%');
  -- Export links are credentials, not participant rows; a shared link naming any of this
  -- participation's documents or batches must no longer be usable.
  DELETE FROM public.export_link l WHERE l.document_ids && ARRAY(
    SELECT id FROM public.document WHERE participation_id = p.id)
    OR l.batch_id IN (SELECT batch_id FROM public.kug200b_batch_member WHERE participation_id = p.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted + v_count;
  SET CONSTRAINTS form_generation_document_id_document_id_fk,
    document_invalidated_by_correction_evidence_correction_id_fk,
    evidence_correction_asu_registration_id_asu_registration_id_fk,
    evidence_correction_ba_reporting_task_id_ba_reporting_task_id_f,
    participation_current_exception_request_fk DEFERRED;
  FOR v_table IN SELECT unnest(v_tables) LOOP
    EXECUTE pg_catalog.format('DELETE FROM public.%I t WHERE t.participation_id = $1 AND NOT EXISTS (SELECT FROM pg_temp.erasure_keep k WHERE k.table_name = %L AND k.rowid = t.ctid)', v_table, v_table) USING p.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;
  END LOOP;
  -- A held notice or account can require the code row, but never its usable secret.
  UPDATE public.activation_code a SET
    code_hash = pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
    delivery_address_hash = CASE WHEN a.delivery_address_hash IS NULL THEN NULL ELSE
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') END,
    revoked_at = CASE WHEN a.used_at IS NULL AND a.locked_at IS NULL AND a.revoked_at IS NULL THEN pg_catalog.now() ELSE a.revoked_at END,
    revoke_reason = CASE WHEN a.used_at IS NULL AND a.locked_at IS NULL AND a.revoked_at IS NULL THEN 'participation_closed'::public.activation_revoke_reason ELSE a.revoke_reason END
  WHERE a.participation_id = p.id AND EXISTS (SELECT FROM pg_temp.erasure_keep k WHERE k.table_name = 'activation_code' AND k.rowid = a.ctid);
  -- A consent or reminder may retain the channel row, but not its address unless the channel
  -- itself (or its whole class) is held. Mark the now value-free row removed and unusable.
  UPDATE public.participant_channel ch SET address = NULL,
    removed_at = coalesce(ch.removed_at, pg_catalog.now()),
    removed_reason = coalesce(ch.removed_reason, 'retention_erasure'::public.channel_removal_reason)
  WHERE ch.participation_id = p.id AND NOT ('participant_channel' = ANY(v_kinds))
    AND NOT ('personnel_file' = ANY(v_classes))
    AND EXISTS (SELECT FROM pg_temp.erasure_keep k WHERE k.table_name = 'participant_channel' AND k.rowid = ch.ctid);
  IF v_has_hold THEN
    UPDATE public.participation SET erasure_pending_at = coalesce(p.erasure_pending_at, pg_catalog.now()),
      erasure_entered_tg = v_entered, erasure_trigger = v_trigger, erasure_trigger_on = v_trigger_on,
      entry_wave_id = NULL, offer_deadline = NULL, tg_start = NULL, tg_end = NULL,
      tg_entry_date = NULL, exit_date = NULL, withdrawn_on = NULL, profiling_done_on = NULL,
      end_reason = NULL, end_reason_source = NULL, end_reason_secondary = '{}',
      profiling_exception_request_id = NULL, placement_agentur_key = NULL, placement_agentur_set_at = NULL,
      funded110_source = NULL, funded110_set_by = NULL, funded110_set_at = NULL,
      evidence_set_since = NULL, created_at = coalesce(p.erasure_pending_at, pg_catalog.now())
    WHERE id = p.id;
  ELSE
    DELETE FROM public.participation WHERE id = p.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;
  END IF;
  PERFORM public.write_audit_event(p.project_id, p.id, 'retention_applied',
    ROW('system', NULL, NULL, 'retention', NULL, NULL, p_run::text)::public.audit_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('retentionClass', 'participation_record', 'deleted', v_deleted, 'kept', v_kept), false);
  -- No subject, actor or record identifier remains in either audit stream.
  UPDATE public.audit_event a SET
    id = coalesce((SELECT replacement FROM pg_temp.erasure_id_map WHERE original = a.id), a.id),
    participation_id = CASE WHEN NOT v_has_hold AND a.participation_id = p.id THEN v_pseudonym ELSE a.participation_id END,
    actor_participation_id = CASE WHEN NOT v_has_hold AND a.actor_participation_id = p.id THEN v_pseudonym ELSE a.actor_participation_id END,
    on_behalf_of_participation_id = CASE WHEN NOT v_has_hold AND a.on_behalf_of_participation_id = p.id THEN v_pseudonym ELSE a.on_behalf_of_participation_id END,
    request_id = public.retention_scrub_text(a.request_id), job_id = public.retention_scrub_text(a.job_id),
    details = public.retention_scrub_json(a.details, false, NULL)
  WHERE a.participation_id = p.id OR a.actor_participation_id = p.id OR a.on_behalf_of_participation_id = p.id
    OR EXISTS (SELECT FROM pg_temp.erasure_id_map m WHERE pg_catalog.row_to_json(a)::text ILIKE '%' || m.original::text || '%');
  UPDATE public.staff_audit_event a SET details = public.retention_scrub_json(a.details, false, NULL),
    request_id = public.retention_scrub_text(a.request_id)
  WHERE EXISTS (SELECT FROM pg_temp.erasure_id_map m WHERE pg_catalog.row_to_json(a)::text ILIKE '%' || m.original::text || '%');
  SET CONSTRAINTS form_generation_document_id_document_id_fk,
    document_invalidated_by_correction_evidence_correction_id_fk,
    evidence_correction_asu_registration_id_asu_registration_id_fk,
    evidence_correction_ba_reporting_task_id_ba_reporting_task_id_f,
    participation_current_exception_request_fk IMMEDIATE;
  DROP TABLE pg_temp.erasure_id_map;
  DROP TABLE pg_temp.erasure_keep;
  DROP TABLE pg_temp.erasure_kept_ids;
  DROP TABLE pg_temp.erasure_all_ids;
  IF r.dry_run THEN RAISE EXCEPTION 'retention_dry_run'; END IF;
  RETURN pg_catalog.jsonb_build_object('completed', NOT v_has_hold, 'documents', v_files);
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'retention_job_active' THEN RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb, 'blocked', 'job_active'); END IF;
  IF SQLERRM = 'retention_job_dependency' THEN RETURN pg_catalog.jsonb_build_object('completed', false, 'documents', '[]'::jsonb, 'blocked', 'job_dependency'); END IF;
  IF SQLERRM = 'retention_dry_run' THEN RETURN pg_catalog.jsonb_build_object('completed', NOT v_has_hold, 'documents', v_files); END IF;
  RAISE;
END $function$;

ALTER FUNCTION public.retention_erase_participation(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_erase_participation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_erase_participation(uuid,uuid) TO transfer_retention;
