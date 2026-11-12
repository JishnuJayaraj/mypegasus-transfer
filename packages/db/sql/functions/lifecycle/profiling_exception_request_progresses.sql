CREATE OR REPLACE FUNCTION public.profiling_exception_request_progresses()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_undecided boolean := OLD.decided_by IS NULL AND OLD.decided_on IS NULL AND OLD.decided_at IS NULL;
  v_new_undecided boolean := NEW.decided_by IS NULL AND NEW.decided_on IS NULL AND NEW.decided_at IS NULL;
  v_new_complete boolean := NEW.decided_by IS NOT NULL AND NEW.decided_on IS NOT NULL AND NEW.decided_at IS NOT NULL;
  v_allowed boolean;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.project_id, NEW.participation_id, NEW.reason_code, NEW.requested_by,
      NEW.requested_on, NEW.requested_at, NEW.evidence_record_id, NEW.evidence_fingerprint)
     IS DISTINCT FROM
     (OLD.id, OLD.project_id, OLD.participation_id, OLD.reason_code, OLD.requested_by,
      OLD.requested_on, OLD.requested_at, OLD.evidence_record_id, OLD.evidence_fingerprint) THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  v_allowed := CASE
    WHEN OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected') THEN v_old_undecided AND v_new_complete
    WHEN OLD.status = 'requested' AND NEW.status IN ('revoked', 'superseded') THEN v_old_undecided AND v_new_undecided
    WHEN OLD.status = 'approved' AND NEW.status = 'revoked' THEN
      (NEW.decided_by, NEW.decided_on, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_on, OLD.decided_at)
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.profiling_exception_request_progresses() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_exception_request_progresses() FROM PUBLIC;
