CREATE OR REPLACE FUNCTION public.profiling_declined_dates(p_participation_ids uuid[])
 RETURNS TABLE(participation_id uuid, declined_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (a.participation_id) a.participation_id,
    coalesce(a.effective_date, (a.occurred_at AT TIME ZONE 'Europe/Berlin')::date)
  FROM public.audit_event a
  WHERE a.participation_id = ANY (p_participation_ids) AND a.event_type = 'status_changed'
    AND a.field = 'profiling_status' AND a.to_value = 'profiling_declined'
  ORDER BY a.participation_id, a.occurred_at DESC, a.id DESC
$function$;

ALTER FUNCTION public.profiling_declined_dates(uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiling_declined_dates(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profiling_declined_dates(uuid[]) TO transfer_app;
