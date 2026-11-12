CREATE OR REPLACE FUNCTION public.audit_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_append_only';
END $function$;

ALTER FUNCTION public.audit_append_only() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.audit_append_only() FROM PUBLIC;
