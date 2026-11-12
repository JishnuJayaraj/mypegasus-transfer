CREATE OR REPLACE FUNCTION public.read_unemployment_period(p_participation_id uuid, p_context public.audit_context, p_key text, p_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_project_id uuid;
  rs public.participant_residence_social_data;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT public.unemployment_reader(p_participation_id, p_context) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO rs FROM public.participant_residence_social_data
  WHERE participation_id = p_participation_id;
  IF rs.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'sensitive_read', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'unemploymentPeriod'),
    false);
  RETURN pg_catalog.jsonb_build_object('revision', coalesce(rs.unemployment_revision, 0),
    'period', coalesce(public.open_sensitive_value(p_participation_id, 'unemploymentPeriod',
      rs.unemployment_period, p_key), 'null'::jsonb));
END $function$;

ALTER FUNCTION public.read_unemployment_period(uuid,public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.read_unemployment_period(uuid,public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_unemployment_period(uuid,public.audit_context,text,text) TO transfer_app;
