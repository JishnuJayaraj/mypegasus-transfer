CREATE OR REPLACE FUNCTION public.read_sensitive_fields(p_participation_id uuid, p_context public.audit_context, p_keys text[], p_key text, p_key_id text, p_token_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  s public.participant_session;
  v_project_id uuid;
  v_all jsonb;
  v_result jsonb := '{}';
  k text;
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) = 0
     OR NOT p_keys <@ (public.sensitive_group_fields('ba_details')
       || public.sensitive_group_fields('health'))
     OR (SELECT pg_catalog.count(DISTINCT f) FROM pg_catalog.unnest(p_keys) f)
       <> pg_catalog.cardinality(p_keys)
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    IF p_keys && '{healthRestrictions,severeDisability}'
       AND NOT public.participant_session_stepped_up(s) THEN
      RAISE EXCEPTION 'step_up_required';
    END IF;
    UPDATE public.participant_session SET last_seen_at = now() WHERE token_hash = s.token_hash;
  ELSIF (p_context).on_behalf_of IS NOT NULL THEN
    -- Staff in assisted mode (Q136): the live mode of this staff session, the fields their roles
    -- see there.
    IF NOT p_keys <@ public.assisted_sensitive_fields(
        public.lock_assisted_mode(p_participation_id, p_context, p_token_hash)) THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
  ELSIF NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id
    WHERE m.project_id = v_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND u.deactivated_at IS NULL
      AND (m.role = 'back_office' AND NOT 'healthRestrictions' = ANY (p_keys)
        OR m.role = 'consultant' AND EXISTS (
          SELECT FROM public.participant_assignment a
          WHERE a.participation_id = p_participation_id AND a.staff_user_id = m.staff_user_id
            AND a.ended_at IS NULL))) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;

  v_all := public.open_sensitive_fields(p_participation_id, p_key, p_key_id);
  FOREACH k IN ARRAY p_keys LOOP
    v_result := v_result || pg_catalog.jsonb_build_object(k, v_all -> k);
    PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read', p_context,
      NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', k), false);
  END LOOP;
  RETURN v_result;
END $function$;

ALTER FUNCTION public.read_sensitive_fields(uuid,public.audit_context,text[],text,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.read_sensitive_fields(uuid,public.audit_context,text[],text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_sensitive_fields(uuid,public.audit_context,text[],text,text,text) TO transfer_app;
