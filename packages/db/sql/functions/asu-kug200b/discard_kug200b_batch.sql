CREATE OR REPLACE FUNCTION public.discard_kug200b_batch(p_context public.audit_context, p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  b public.kug200b_batch;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  b := public.lock_kug200b_batch(p_context, p_batch_id);
  PERFORM FROM public.kug200b_batch WHERE id = b.id FOR UPDATE;
  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'batch_not_open';
  END IF;
  UPDATE public.kug200b_batch SET status = 'discarded',
    discarded_by = (p_context).staff_user_id, discarded_at = now()
  WHERE id = b.id;
  UPDATE public.kug200b_batch_member SET active = false WHERE batch_id = b.id;
  PERFORM public.write_audit_event(b.project_id, NULL, 'kug200b_batch_discarded', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('batchId', b.id,
      'count', b.member_count), false);
END $function$;

ALTER FUNCTION public.discard_kug200b_batch(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.discard_kug200b_batch(public.audit_context,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discard_kug200b_batch(public.audit_context,uuid) TO transfer_app;
