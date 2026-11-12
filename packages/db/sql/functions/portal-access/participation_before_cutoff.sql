CREATE OR REPLACE FUNCTION public.participation_before_cutoff(p public.participation)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p.status NOT IN ('imported', 'contacted', 'unreachable') OR NOT EXISTS (
    SELECT FROM public.project_entry_wave w
    WHERE w.id = p.entry_wave_id AND w.latest_entry_date IS NOT NULL
      AND (now() AT TIME ZONE 'Europe/Berlin')::date > w.latest_entry_date)
$function$;

ALTER FUNCTION public.participation_before_cutoff(public.participation) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participation_before_cutoff(public.participation) FROM PUBLIC;
