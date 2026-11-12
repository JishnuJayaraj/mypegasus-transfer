CREATE OR REPLACE FUNCTION public.activation_code_open(c public.activation_code)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT c.revoked_at IS NULL AND c.locked_at IS NULL AND c.used_at IS NULL
    AND c.expires_at > now()
    AND (c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL)
    AND (c.channel <> 'in_person' OR c.delivery_status IN ('pending', 'sent', 'unknown'))
$function$;

ALTER FUNCTION public.activation_code_open(public.activation_code) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.activation_code_open(public.activation_code) FROM PUBLIC;
