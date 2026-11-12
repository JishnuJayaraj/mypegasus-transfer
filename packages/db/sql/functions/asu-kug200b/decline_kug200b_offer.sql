CREATE OR REPLACE FUNCTION public.decline_kug200b_offer(p_context public.audit_context, p_participation_id uuid, p_declined_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation;
BEGIN
  IF p_participation_id IS NULL OR p_declined_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_kug200b_actor(p_participation_id, p_context, true);
  IF EXISTS (SELECT FROM public.document d
             WHERE d.participation_id = r.id AND d.type = 'kug200b_signed_scan'
               AND d.review_state = 'accepted' AND d.deleted_at IS NULL
               AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL) THEN
    RAISE EXCEPTION 'kug200b_signed';
  END IF;
  IF (SELECT channel FROM public.asu_record WHERE participation_id = r.id FOR SHARE)
     IS NOT DISTINCT FROM 'kug_200b' THEN
    RAISE EXCEPTION 'asu_route_kug200b';
  END IF;
  IF EXISTS (SELECT FROM public.kug200b_decline WHERE participation_id = r.id) THEN
    RAISE EXCEPTION 'kug200b_declined';
  END IF;
  IF p_declined_on > public.berlin_today() THEN
    RAISE EXCEPTION 'declined_on_in_future';
  END IF;
  INSERT INTO public.kug200b_decline (participation_id, project_id, declined_on, declined_by)
  VALUES (r.id, r.project_id, p_declined_on, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'kug200b_offer_declined', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('declinedOn',
      pg_catalog.to_char(p_declined_on, 'YYYY-MM-DD')), false);
END $function$;

ALTER FUNCTION public.decline_kug200b_offer(public.audit_context,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.decline_kug200b_offer(public.audit_context,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decline_kug200b_offer(public.audit_context,uuid,date) TO transfer_app;
