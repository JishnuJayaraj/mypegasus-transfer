CREATE OR REPLACE FUNCTION public.assert_appointment_audience(p_project_id uuid, p_wave_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_wave_id IS NULL THEN RETURN; END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'not_ta_tg';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_entry_wave
                 WHERE id = p_wave_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'wave_of_other_project';
  END IF;
END $function$;

ALTER FUNCTION public.assert_appointment_audience(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_appointment_audience(uuid,uuid) FROM PUBLIC;
