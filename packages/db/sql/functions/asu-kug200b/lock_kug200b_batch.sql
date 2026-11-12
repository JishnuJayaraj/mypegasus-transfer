CREATE OR REPLACE FUNCTION public.lock_kug200b_batch(p_context public.audit_context, p_batch_id uuid)
 RETURNS public.kug200b_batch
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id FROM public.kug200b_batch WHERE id = p_batch_id;
  IF NOT FOUND THEN
    PERFORM public.assert_context(p_context, NULL, '{user}');
    RAISE EXCEPTION 'batch_not_found';
  END IF;
  PERFORM public.lock_kug200b_batch_project(p_context, v_project_id, 'batch_not_found');
  SELECT * INTO b FROM public.kug200b_batch WHERE id = p_batch_id;
  RETURN b;
END $function$;

ALTER FUNCTION public.lock_kug200b_batch(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_kug200b_batch(public.audit_context,uuid) FROM PUBLIC;
