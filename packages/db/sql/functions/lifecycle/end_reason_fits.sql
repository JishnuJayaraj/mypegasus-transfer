CREATE OR REPLACE FUNCTION public.end_reason_fits(p_status public.main_status, p_reason public.end_reason)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE p_status
    WHEN 'withdrawn' THEN p_reason = ANY ('{declined_profiling,declined_dsv,no_response,never_contacted,not_informed,placed_direct,self_employed,retirement,other_measure,deceased,other}'::public.end_reason[])
    WHEN 'exited' THEN p_reason = ANY ('{placed_permanent,placed_fixed_term,self_employed,retirement,apprenticeship_or_study,max_duration_reached,own_termination_without_job,terminated_by_tg,long_term_illness_reduced_earning_capacity,deceased,other}'::public.end_reason[])
    ELSE false
  END
$function$;

ALTER FUNCTION public.end_reason_fits(public.main_status,public.end_reason) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.end_reason_fits(public.main_status,public.end_reason) FROM PUBLIC;
