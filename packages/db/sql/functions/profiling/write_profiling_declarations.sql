CREATE OR REPLACE FUNCTION public.write_profiling_declarations(p_participation_id uuid, p_context public.audit_context, p_jobboerse_choice public.jobboerse_choice, p_ba_contact_consent boolean, p_revision integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  x public.participant_profiling;
  v_revision integer;
  v_fields text[] := '{}';
BEGIN
  IF p_revision IS NULL OR p_revision < 0 THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  r := public.lock_profiler(p_participation_id, p_context);
  SELECT * INTO x FROM public.participant_profiling WHERE participation_id = r.id FOR UPDATE;
  v_revision := coalesce(x.revision, 0);
  IF p_revision <> v_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  IF x.jobboerse_choice IS DISTINCT FROM p_jobboerse_choice THEN
    v_fields := v_fields || 'jobboerseChoice'::text;
  END IF;
  IF x.ba_contact_consent IS DISTINCT FROM p_ba_contact_consent THEN
    v_fields := v_fields || 'baContactConsent'::text;
  END IF;
  IF pg_catalog.cardinality(v_fields) = 0 THEN
    RETURN v_revision;
  END IF;
  INSERT INTO public.participant_profiling (participation_id, project_id, jobboerse_choice,
    ba_contact_consent, declarations_recorded_by, declarations_recorded_at, revision)
  VALUES (r.id, r.project_id, p_jobboerse_choice, p_ba_contact_consent,
    (p_context).staff_user_id, pg_catalog.now(), 1)
  ON CONFLICT (participation_id) DO UPDATE SET jobboerse_choice = EXCLUDED.jobboerse_choice,
    ba_contact_consent = EXCLUDED.ba_contact_consent,
    declarations_recorded_by = EXCLUDED.declarations_recorded_by,
    declarations_recorded_at = EXCLUDED.declarations_recorded_at,
    revision = v_revision + 1, updated_at = pg_catalog.now();
  PERFORM public.write_audit_event(r.project_id, r.id, 'profiling_declarations_recorded',
    p_context, NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('fields', v_fields),
    false);
  RETURN v_revision + 1;
END $function$;

ALTER FUNCTION public.write_profiling_declarations(uuid,public.audit_context,public.jobboerse_choice,boolean,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_profiling_declarations(uuid,public.audit_context,public.jobboerse_choice,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_profiling_declarations(uuid,public.audit_context,public.jobboerse_choice,boolean,integer) TO transfer_app;
