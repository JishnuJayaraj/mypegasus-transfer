CREATE OR REPLACE FUNCTION public.participation_closed_at(p public.participation)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p.status IN ('withdrawn', 'ta_completed', 'exited') THEN (
    SELECT pg_catalog.max(e.occurred_at) FROM public.audit_event e
    WHERE e.participation_id = p.id AND e.event_type = 'status_changed' AND e.field = 'status'
      AND e.to_value IN ('withdrawn', 'ta_completed', 'exited')) END
$function$;

ALTER FUNCTION public.participation_closed_at(public.participation) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participation_closed_at(public.participation) FROM PUBLIC;
