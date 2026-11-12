CREATE OR REPLACE FUNCTION public.sign_dsv(p_context public.audit_context, p_participation_id uuid, p_scan_id uuid, p_status_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation;
BEGIN
 PERFORM public.assert_context(p_context, p_participation_id, '{user}');
 r := public.lock_participation(p_participation_id);
 IF NOT EXISTS (SELECT FROM public.document WHERE id = p_scan_id AND participation_id = r.id AND type = 'dsv_signed_scan' AND deleted_at IS NULL) THEN RAISE EXCEPTION 'document_not_found'; END IF;
 IF (p_context).on_behalf_of IS NOT NULL OR NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
 IF r.status_version IS DISTINCT FROM p_status_version THEN RAISE EXCEPTION 'stale_status'; END IF;
 IF NOT EXISTS (SELECT FROM public.dsv_facts(ARRAY[r.id]) f JOIN public.dsv_offer o ON o.id = f.offer_id WHERE f.document_id = p_scan_id AND o.ended_as IS NULL) THEN RAISE EXCEPTION 'dsv_scan_missing'; END IF;
 RETURN public.apply_status_change(r.id, 'dsv_status', 'dsv_offered', 'dsv_signed', p_context);
END $function$;

ALTER FUNCTION public.sign_dsv(public.audit_context,uuid,uuid,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.sign_dsv(public.audit_context,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_dsv(public.audit_context,uuid,uuid,integer) TO transfer_app;
