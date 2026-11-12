CREATE OR REPLACE FUNCTION public.ba_reporting_task_progresses()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  IF (NEW.id, NEW.participation_id, NEW.project_id, NEW.reporting_kind, NEW.subject_date,
      NEW.amendment_id, NEW.created_at, NEW.replaces_task_id, NEW.correction_id)
     IS DISTINCT FROM
     (OLD.id, OLD.participation_id, OLD.project_id, OLD.reporting_kind, OLD.subject_date,
      OLD.amendment_id, OLD.created_at, OLD.replaces_task_id, OLD.correction_id) THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  IF OLD.status::text = 'pending' THEN
    IF NEW.status::text NOT IN ('reported', 'not_required') OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'task_immutable';
    END IF;
  ELSIF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
     OR (NEW.status, NEW.reported_on, NEW.not_required_reason, NEW.decided_by, NEW.decided_at,
         NEW.channel, NEW.reference)
       IS DISTINCT FROM
       (OLD.status, OLD.reported_on, OLD.not_required_reason, OLD.decided_by, OLD.decided_at,
         OLD.channel, OLD.reference) THEN
    RAISE EXCEPTION 'task_immutable';
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.ba_reporting_task_progresses() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.ba_reporting_task_progresses() FROM PUBLIC;
