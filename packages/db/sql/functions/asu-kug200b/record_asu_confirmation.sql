CREATE OR REPLACE FUNCTION public.record_asu_confirmation(p_context public.audit_context, p_participation_id uuid, p_registration_id uuid, p_confirmed_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  g public.asu_registration;
BEGIN
  IF p_participation_id IS NULL OR p_registration_id IS NULL OR p_confirmed_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(r.id, (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  SELECT * INTO g FROM public.asu_registration
  WHERE id = p_registration_id AND participation_id = r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asu_registration_not_found';
  END IF;
  IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
    RAISE EXCEPTION 'asu_registration_corrected';
  END IF;
  IF g.channel <> 'kug_200b' THEN
    RAISE EXCEPTION 'asu_not_kug200b';
  END IF;
  IF g.confirmed_on IS NOT NULL THEN
    RAISE EXCEPTION 'asu_confirmed';
  END IF;
  IF p_confirmed_on > public.berlin_today() THEN
    RAISE EXCEPTION 'confirmed_on_in_future';
  END IF;
  IF p_confirmed_on < g.registered_on THEN
    RAISE EXCEPTION 'confirmed_before_submission';
  END IF;
  UPDATE public.asu_registration SET confirmed_on = p_confirmed_on,
    confirmed_by = (p_context).staff_user_id, confirmed_at = now()
  WHERE id = g.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_confirmation_recorded', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('registrationId', g.id,
      'confirmedOn', pg_catalog.to_char(p_confirmed_on, 'YYYY-MM-DD')), false);
END $function$;

ALTER FUNCTION public.record_asu_confirmation(public.audit_context,uuid,uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_asu_confirmation(public.audit_context,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_asu_confirmation(public.audit_context,uuid,uuid,date) TO transfer_app;
