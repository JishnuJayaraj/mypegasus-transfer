CREATE OR REPLACE FUNCTION public.retention_erasure_facts(p_run uuid)
 RETURNS TABLE(participation_id uuid, any_entered_tg boolean, fundings text[], kug_final_settlement_date date, measure110_settlement_date date, erasure_pending_at timestamp with time zone, erasure_entered_tg boolean, erasure_trigger text, erasure_trigger_on date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.retention_run_of(p_run);
  RETURN QUERY SELECT p.id, bool_or(coalesce(q.erasure_entered_tg, q.tg_entry_date IS NOT NULL)), array_agg(q.funded110::text),
    pr.kug_final_settlement_date, pr.measure110_settlement_date, p.erasure_pending_at,
    p.erasure_entered_tg, p.erasure_trigger, p.erasure_trigger_on
  FROM public.participation p JOIN public.project pr ON pr.id = p.project_id
  JOIN public.participation q ON q.project_id = p.project_id
  WHERE p.status::text IN ('withdrawn','ta_completed','exited')
  GROUP BY p.id, pr.kug_final_settlement_date, pr.measure110_settlement_date;
END $function$;

ALTER FUNCTION public.retention_erasure_facts(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_erasure_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_erasure_facts(uuid) TO transfer_retention;
