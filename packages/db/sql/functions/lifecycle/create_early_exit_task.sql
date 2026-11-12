CREATE OR REPLACE FUNCTION public.create_early_exit_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_end date := coalesce(NEW.tg_end,
    (SELECT default_tg_end FROM public.project_entry_wave WHERE id = NEW.entry_wave_id));
BEGIN
  IF v_end IS NULL OR NEW.exit_date < v_end THEN
    INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind, subject_date)
    VALUES (NEW.id, NEW.project_id, 'early_exit', NEW.exit_date);
  END IF;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.create_early_exit_task() OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.create_early_exit_task() FROM PUBLIC;
