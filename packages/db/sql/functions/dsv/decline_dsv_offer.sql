CREATE OR REPLACE FUNCTION public.decline_dsv_offer(p_context public.audit_context, p_participation_id uuid, p_offer_id uuid, p_expected_status_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL OR NOT public.document_staff_roles(r.id,
    (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM FROM public.dsv_offer WHERE id = p_offer_id AND participation_id = r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF r.status_version IS DISTINCT FROM p_expected_status_version OR NOT EXISTS (
    SELECT FROM public.dsv_offer WHERE id = p_offer_id AND ended_as IS NULL) THEN
    RAISE EXCEPTION 'stale_status';
  END IF;
  RETURN public.apply_status_change(r.id, 'dsv_status', 'dsv_offered', 'dsv_declined', p_context);
END $function$;

ALTER FUNCTION public.decline_dsv_offer(public.audit_context,uuid,uuid,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.decline_dsv_offer(public.audit_context,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decline_dsv_offer(public.audit_context,uuid,uuid,integer) TO transfer_app;
