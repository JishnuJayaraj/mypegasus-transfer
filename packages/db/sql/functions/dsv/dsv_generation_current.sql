CREATE OR REPLACE FUNCTION public.dsv_generation_current(p_generation_id uuid, p_organisation_sha256 text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce((
    SELECT g.source_token = public.dsv_source_token(g.participation_id, p_organisation_sha256)
      AND g.offer_deadline >= (pg_catalog.now() AT TIME ZONE 'Europe/Berlin')::date
      AND (g.deadline_kind::text <> 'wave' OR g.offer_deadline IS NOT DISTINCT FROM (
        SELECT w.signing_deadline FROM public.participation p
        JOIN public.project_entry_wave w ON w.id = p.entry_wave_id
        WHERE p.id = g.participation_id))
    FROM public.form_generation g
    WHERE g.id = p_generation_id AND g.form_code::text = 'dsv'), false)
$function$;

ALTER FUNCTION public.dsv_generation_current(uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.dsv_generation_current(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dsv_generation_current(uuid,text) TO transfer_app;
