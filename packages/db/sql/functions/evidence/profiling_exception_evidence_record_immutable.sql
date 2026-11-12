CREATE OR REPLACE FUNCTION public.profiling_exception_evidence_record_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record_immutable';
END $function$;

ALTER FUNCTION public.profiling_exception_evidence_record_immutable() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_exception_evidence_record_immutable() FROM PUBLIC;
