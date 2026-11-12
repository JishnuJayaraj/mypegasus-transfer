CREATE OR REPLACE FUNCTION public.keep_privacy_notice_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.in_retention_run() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'privacy_notice_immutable';
END $function$;

ALTER FUNCTION public.keep_privacy_notice_immutable() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.keep_privacy_notice_immutable() FROM PUBLIC;
