CREATE OR REPLACE FUNCTION public.evidence_correction_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD.status::text <> 'requested' OR NEW.status::text = 'requested'
     OR (NEW.id, NEW.project_id, NEW.participation_id, NEW.target_kind, NEW.action,
         NEW.document_id, NEW.asu_registration_id, NEW.ba_reporting_task_id, NEW.wrong_person,
         NEW.corrected_registered_on, NEW.field_key, NEW.dsv_offer_id, NEW.signature_paper,
         NEW.signature_kind, NEW.corrected_on, NEW.original_on, NEW.reason, NEW.source,
         NEW.retention_class, NEW.requested_by, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.project_id, OLD.participation_id, OLD.target_kind, OLD.action,
         OLD.document_id, OLD.asu_registration_id, OLD.ba_reporting_task_id, OLD.wrong_person,
         OLD.corrected_registered_on, OLD.field_key, OLD.dsv_offer_id, OLD.signature_paper,
         OLD.signature_kind, OLD.corrected_on, OLD.original_on, OLD.reason, OLD.source,
         OLD.retention_class, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'correction_immutable';
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.evidence_correction_append_only() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.evidence_correction_append_only() FROM PUBLIC;
