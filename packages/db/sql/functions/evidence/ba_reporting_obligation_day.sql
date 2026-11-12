CREATE OR REPLACE FUNCTION public.ba_reporting_obligation_day(p_task_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE chain AS (
    SELECT id, replaces_task_id, created_at, 0 AS depth
    FROM public.ba_reporting_task WHERE id = p_task_id
    UNION ALL
    SELECT t.id, t.replaces_task_id, t.created_at, c.depth + 1
    FROM public.ba_reporting_task t JOIN chain c ON t.id = c.replaces_task_id
  )
  SELECT (created_at AT TIME ZONE 'Europe/Berlin')::date FROM chain
  ORDER BY depth DESC LIMIT 1
$function$;

ALTER FUNCTION public.ba_reporting_obligation_day(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.ba_reporting_obligation_day(uuid) FROM PUBLIC;
