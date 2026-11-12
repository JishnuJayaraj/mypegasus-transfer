-- Restrict an erasure anchor and its retained records to the retention role; legal holds remain
-- administrable (data-protection.md, retention and deletion).
CREATE OR REPLACE FUNCTION refuse_in_evidence_set_phase()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN pg_catalog.to_jsonb(OLD) ELSE pg_catalog.to_jsonb(NEW) END;
  v_id uuid;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'participation' THEN
    IF TG_OP = 'INSERT' AND NEW.erasure_pending_at IS NOT NULL THEN RAISE EXCEPTION 'erasure_pending'; END IF;
    IF TG_OP = 'UPDATE' AND NEW.erasure_pending_at IS DISTINCT FROM OLD.erasure_pending_at THEN RAISE EXCEPTION 'erasure_pending'; END IF;
    IF TG_OP <> 'INSERT' AND OLD.erasure_pending_at IS NOT NULL THEN RAISE EXCEPTION 'erasure_pending'; END IF;
    IF TG_OP <> 'INSERT' AND OLD.evidence_set_since IS NOT NULL THEN RAISE EXCEPTION 'evidence_set_phase'; END IF;
  ELSE
    v_id := (v_row ->> 'participation_id')::uuid;
    IF v_id IS NOT NULL AND EXISTS (SELECT FROM public.participation WHERE id = v_id AND erasure_pending_at IS NOT NULL) THEN
      RAISE EXCEPTION 'erasure_pending';
    END IF;
    IF v_id IS NOT NULL AND EXISTS (SELECT FROM public.participation WHERE id = v_id AND evidence_set_since IS NOT NULL) THEN
      RAISE EXCEPTION 'evidence_set_phase';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
