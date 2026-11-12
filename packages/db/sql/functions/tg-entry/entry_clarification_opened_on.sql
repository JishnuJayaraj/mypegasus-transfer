CREATE OR REPLACE FUNCTION public.entry_clarification_opened_on(p_participation_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN pj.type::text = 'ta_tg' AND r.status::text = 'informed'
     AND r.dsv_status::text = 'dsv_signed'
     AND coalesce(r.tg_start, w.default_tg_start) IS NOT NULL
     AND public.berlin_today() > coalesce(r.tg_start, w.default_tg_start)
   THEN coalesce(r.tg_start, w.default_tg_start) + 1 END
 FROM public.participation r JOIN public.project pj ON pj.id = r.project_id
 LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
 WHERE r.id = p_participation_id
$function$;

ALTER FUNCTION public.entry_clarification_opened_on(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.entry_clarification_opened_on(uuid) FROM PUBLIC;
