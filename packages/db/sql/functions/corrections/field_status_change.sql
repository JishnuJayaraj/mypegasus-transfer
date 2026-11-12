CREATE OR REPLACE FUNCTION public.field_status_change(p_participation_id uuid, p_field_key text)
 RETURNS TABLE(actor_type text, occurred_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT a.actor_type::text, a.occurred_at FROM public.audit_event a
  WHERE a.participation_id = p_participation_id AND a.event_type = 'status_changed'
    AND (p_field_key, a.field::text, a.to_value) IN (('profilingDoneOn', 'profiling_status',
      'profiling_done'), ('withdrawnOn', 'status', 'withdrawn'))
  ORDER BY a.occurred_at DESC, a.seq DESC LIMIT 1
$function$;

ALTER FUNCTION public.field_status_change(uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.field_status_change(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.field_status_change(uuid,text) TO transfer_app;
