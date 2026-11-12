CREATE OR REPLACE FUNCTION public.activation_needs_birth_date(c public.activation_code)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT c.channel = 'letter' OR EXISTS (
    SELECT FROM public.participant_identity i
    WHERE i.participation_id = c.participation_id AND i.birth_date IS NOT NULL)
$function$;

ALTER FUNCTION public.activation_needs_birth_date(public.activation_code) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.activation_needs_birth_date(public.activation_code) FROM PUBLIC;
