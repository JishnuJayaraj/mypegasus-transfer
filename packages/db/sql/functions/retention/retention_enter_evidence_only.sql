CREATE OR REPLACE FUNCTION public.retention_enter_evidence_only(p_run uuid, p_participation_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  p public.participation;
BEGIN
  p := public.lock_participation(p_participation_id);
  IF p.status::text NOT IN ('withdrawn', 'ta_completed', 'exited') OR p.evidence_set_since IS NOT NULL
     OR NOT (p.tg_entry_date IS NOT NULL OR p.funded110::text = 'known_yes')
     OR NOT public.retention_classes_left(p.id) <@ '{participation_record,evidence_set}'::text[] THEN
    RETURN false;
  END IF;
  IF r.dry_run THEN RETURN true; END IF;
  UPDATE public.participation SET evidence_set_since = pg_catalog.now() WHERE id = p.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'retention_applied',
    ROW('system', NULL, NULL, 'retention', NULL, NULL, p_run::text)::public.audit_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('retentionClass', 'evidence_only', 'deleted', 0, 'kept', 0), false);
  RETURN true;
END $function$;

ALTER FUNCTION public.retention_enter_evidence_only(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_enter_evidence_only(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_enter_evidence_only(uuid,uuid) TO transfer_retention;
