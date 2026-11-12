CREATE OR REPLACE FUNCTION public.write_unemployment_period(p_participation_id uuid, p_context public.audit_context, p_period jsonb, p_revision integer, p_key text, p_key_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  rs public.participant_residence_social_data;
  v_period jsonb := nullif(p_period, 'null'::jsonb);
  v_revision integer;
BEGIN
  IF p_revision IS NULL OR p_revision < 0
     OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR v_period IS NOT NULL AND NOT (pg_catalog.jsonb_typeof(v_period) = 'object'
       AND ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(v_period) k ORDER BY k)
         = '{from,until}'::text[]
       AND public.iso_date_valid(v_period -> 'from')
       AND (v_period -> 'until' = 'null'::jsonb OR public.iso_date_valid(v_period -> 'until')))
  THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_profiler(p_participation_id, p_context);
  SELECT * INTO rs FROM public.participant_residence_social_data WHERE participation_id = r.id
  FOR UPDATE;
  v_revision := coalesce(rs.unemployment_revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF rs.key_id <> p_key_id THEN
    RAISE EXCEPTION 'key_unknown';
  END IF;
  IF public.open_sensitive_value(r.id, 'unemploymentPeriod', rs.unemployment_period, p_key)
     IS NOT DISTINCT FROM v_period THEN
    RETURN v_revision;
  END IF;
  INSERT INTO public.participant_residence_social_data (participation_id, project_id,
    unemployment_period, unemployment_period_present, unemployment_revision, key_id)
  VALUES (r.id, r.project_id,
    public.seal_sensitive_value(r.id, 'unemploymentPeriod', v_period, p_key),
    v_period IS NOT NULL, v_revision + 1, p_key_id)
  ON CONFLICT (participation_id) DO UPDATE SET unemployment_period = EXCLUDED.unemployment_period,
    unemployment_period_present = EXCLUDED.unemployment_period_present,
    unemployment_revision = EXCLUDED.unemployment_revision,
    key_id = EXCLUDED.key_id, written_at = pg_catalog.now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'sensitive_write', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('key', 'unemploymentPeriod'), false);
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_unemployment_period(uuid,public.audit_context,jsonb,integer,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_unemployment_period(uuid,public.audit_context,jsonb,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_unemployment_period(uuid,public.audit_context,jsonb,integer,text,text) TO transfer_app;
