CREATE OR REPLACE FUNCTION public.end_assisted_modes_of_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE m public.assisted_mode;
BEGIN
  FOR m IN SELECT * FROM public.assisted_mode
           WHERE staff_session_hash = NEW.token_hash AND ended_at IS NULL ORDER BY started_at
           FOR UPDATE LOOP
    PERFORM public.close_assisted_mode(m, 'staff_session_ended', NULL);
  END LOOP;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.end_assisted_modes_of_session() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.end_assisted_modes_of_session() FROM PUBLIC;
