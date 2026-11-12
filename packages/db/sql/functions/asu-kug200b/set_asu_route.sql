CREATE OR REPLACE FUNCTION public.set_asu_route(p_context public.audit_context, p_participation_id uuid, p_channel public.asu_channel, p_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  a public.asu_record;
BEGIN
  IF p_participation_id IS NULL OR p_channel IS NULL OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_asu_actor(p_participation_id, p_context, '{project_lead,consultant}');
  SELECT * INTO a FROM public.asu_record WHERE participation_id = r.id FOR UPDATE;
  IF coalesce(a.version, 0) <> p_version THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF EXISTS (SELECT FROM public.asu_registration WHERE participation_id = r.id
      AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
    RAISE EXCEPTION 'asu_registered';
  END IF;
  IF a.channel IS NOT DISTINCT FROM p_channel THEN
    RETURN p_version;
  END IF;
  IF p_channel = 'kug_200b' AND EXISTS (
       SELECT FROM public.agentur_submission
       WHERE participation_id = r.id AND form_code = 'kug200b') THEN
    RAISE EXCEPTION 'asu_kug200b_submitted';
  END IF;
  INSERT INTO public.asu_record (participation_id, project_id, channel, version, set_by)
  VALUES (r.id, r.project_id, p_channel, 1, (p_context).staff_user_id)
  ON CONFLICT (participation_id) DO UPDATE SET channel = EXCLUDED.channel,
    version = public.asu_record.version + 1, set_by = EXCLUDED.set_by, set_at = now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'asu_route_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'channel', p_channel, 'previousChannel', a.channel)), false);
  RETURN p_version + 1;
END $function$;

ALTER FUNCTION public.set_asu_route(public.audit_context,uuid,public.asu_channel,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_asu_route(public.audit_context,uuid,public.asu_channel,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_asu_route(public.audit_context,uuid,public.asu_channel,integer) TO transfer_app;
