CREATE OR REPLACE FUNCTION public.participant_session_live(s public.participant_session)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT s.ended_at IS NULL AND s.last_seen_at > now() - interval '30 minutes'
    AND s.created_at > now() - interval '12 hours'
$function$;

ALTER FUNCTION public.participant_session_live(public.participant_session) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.participant_session_live(public.participant_session) FROM PUBLIC;
