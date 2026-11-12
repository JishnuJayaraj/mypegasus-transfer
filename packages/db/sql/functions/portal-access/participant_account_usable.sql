CREATE OR REPLACE FUNCTION public.participant_account_usable(p public.participation)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p.status NOT IN ('withdrawn', 'ta_completed', 'exited')
    AND (SELECT status FROM public.project WHERE id = p.project_id) = 'active'
    AND EXISTS (SELECT FROM public.participant_account a WHERE a.participation_id = p.id)
$function$;

ALTER FUNCTION public.participant_account_usable(public.participation) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participant_account_usable(public.participation) FROM PUBLIC;
