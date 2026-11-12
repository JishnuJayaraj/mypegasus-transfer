CREATE OR REPLACE FUNCTION public.set_placement_agentur(p_participation_id uuid, p_agentur_key text, p_base_defaults_version integer, p_context public.audit_context, p_pin_version integer DEFAULT NULL::integer, p_pin_content jsonb DEFAULT NULL::jsonb, p_pin_sha256 text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project_id uuid;
  p public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
  IF coalesce(p_agentur_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_base_defaults_version < 1, true)
     OR pg_catalog.num_nulls(p_pin_version, p_pin_content, p_pin_sha256) NOT IN (0, 3) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- project_id never changes, so it can be read before the lock.
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM public.lock_project_setup(v_project_id);
  p := public.lock_participation(p_participation_id);
  IF NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = v_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role IN ('project_lead', 'back_office') AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF p.placement_agentur_key = p_agentur_key THEN
    RAISE EXCEPTION 'placement_agentur_unchanged';
  END IF;
  IF p_pin_version IS NOT NULL THEN
    -- Checks the content and the hash against a stored version, as for every pin, and refuses an
    -- Agentur the project has pinned already (`template_already_pinned`, 0023).
    PERFORM public.pin_agentur_template(v_project_id, p_agentur_key, p_pin_version, p_pin_content,
      p_pin_sha256, p_base_defaults_version, p_context);
  END IF;
  UPDATE public.participation
  SET placement_agentur_key = p_agentur_key, placement_agentur_set_at = now()
  WHERE id = p_participation_id;
  RETURN public.write_audit_event(v_project_id, p_participation_id, 'placement_agentur_set', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'agenturKey', p_agentur_key, 'previousAgenturKey', p.placement_agentur_key,
      'baseDefaultsVersion', p_base_defaults_version)), false);
END $function$;

ALTER FUNCTION public.set_placement_agentur(uuid,text,integer,public.audit_context,integer,jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_placement_agentur(uuid,text,integer,public.audit_context,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_placement_agentur(uuid,text,integer,public.audit_context,integer,jsonb,text) TO transfer_app;
