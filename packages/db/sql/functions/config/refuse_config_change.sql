CREATE OR REPLACE FUNCTION public.refuse_config_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append_only';
END $function$;

ALTER FUNCTION public.refuse_config_change() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.refuse_config_change() FROM PUBLIC;
