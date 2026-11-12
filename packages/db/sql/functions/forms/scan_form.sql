CREATE OR REPLACE FUNCTION public.scan_form(p_type public.document_type)
 RETURNS public.form_code
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE p_type::text
    WHEN 'tl407_signed_scan' THEN 'tl407'::public.form_code
    WHEN 'kug200b_signed_scan' THEN 'kug200b'::public.form_code END
$function$;

ALTER FUNCTION public.scan_form(public.document_type) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.scan_form(public.document_type) FROM PUBLIC;
