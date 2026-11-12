CREATE OR REPLACE FUNCTION public.contact_address_valid(p_kind public.contact_channel_kind, p_address text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(CASE p_kind
    WHEN 'email' THEN p_address ~ '^[^@[:space:]A-Z]+@[^@[:space:]A-Z]+[.][^@[:space:]A-Z]+$'
      AND length(p_address) <= 254
    ELSE p_address ~ '^[+][1-9][0-9]{7,14}$' END, false)
$function$;

ALTER FUNCTION public.contact_address_valid(public.contact_channel_kind,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.contact_address_valid(public.contact_channel_kind,text) FROM PUBLIC;
