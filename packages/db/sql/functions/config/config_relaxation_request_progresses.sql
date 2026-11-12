CREATE OR REPLACE FUNCTION public.config_relaxation_request_progresses()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_undecided boolean := OLD.decided_by IS NULL AND OLD.decided_on IS NULL AND OLD.decided_at IS NULL;
  v_new_undecided boolean := NEW.decided_by IS NULL AND NEW.decided_on IS NULL AND NEW.decided_at IS NULL;
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.project_id, NEW.rule_id, NEW.reason_code, NEW.requested_by, NEW.requested_on,
      NEW.requested_at) IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.rule_id, OLD.reason_code,
      OLD.requested_by, OLD.requested_on, OLD.requested_at)
     OR NOT coalesce(OLD.status = 'requested' AND v_old_undecided AND CASE NEW.status
       WHEN 'approved' THEN NOT v_new_undecided
       WHEN 'rejected' THEN NOT v_new_undecided
       WHEN 'withdrawn' THEN v_new_undecided
       ELSE false END, false) THEN
    RAISE EXCEPTION 'request_immutable';
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.config_relaxation_request_progresses() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.config_relaxation_request_progresses() FROM PUBLIC;
