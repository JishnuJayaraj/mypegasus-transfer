CREATE OR REPLACE FUNCTION public.kug200b_batch_print_sources(p_context public.audit_context, p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
BEGIN
  PERFORM public.assert_context(p_context, NULL, '{user}');
  SELECT * INTO b FROM public.kug200b_batch WHERE id = p_batch_id;
  IF NOT FOUND OR NOT public.kug200b_batch_lead(b.project_id, (p_context).staff_user_id) THEN
    RAISE EXCEPTION 'batch_not_found';
  END IF;
  RETURN public.kug200b_batch_export_sources(b, 'kug200b_batch_artifact');
END $function$;

ALTER FUNCTION public.kug200b_batch_print_sources(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_print_sources(public.audit_context,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kug200b_batch_print_sources(public.audit_context,uuid) TO transfer_app;
