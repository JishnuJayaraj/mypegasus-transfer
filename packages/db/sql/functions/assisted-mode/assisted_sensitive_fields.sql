CREATE OR REPLACE FUNCTION public.assisted_sensitive_fields(p_roles text[])
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ARRAY(
    SELECT f FROM pg_catalog.unnest(public.sensitive_group_fields('ba_details')
      || public.sensitive_group_fields('health')) WITH ORDINALITY AS u(f, o)
    WHERE 'consultant' = ANY (p_roles)
      OR 'project_lead' = ANY (p_roles) AND f IN ('healthRestrictions', 'severeDisability')
      OR 'back_office' = ANY (p_roles) AND f <> 'healthRestrictions'
    ORDER BY o)
$function$;

ALTER FUNCTION public.assisted_sensitive_fields(text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assisted_sensitive_fields(text[]) FROM PUBLIC;
