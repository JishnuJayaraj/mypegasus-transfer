CREATE OR REPLACE FUNCTION public.retention_purge_credentials(p_run uuid, p_cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.retention_run := public.retention_run_of(p_run);
  v jsonb := '{}';
  n integer;
BEGIN
  IF p_cutoff IS NULL OR p_cutoff >= r.run_day THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  BEGIN
    DELETE FROM public.document_link WHERE (expires_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('document_link', n);
    DELETE FROM public.export_link WHERE (expires_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('export_link', n);
    DELETE FROM public.assisted_mode WHERE (ended_at AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('assisted_mode', n);
    DELETE FROM public.participant_session
    WHERE (coalesce(ended_at, last_seen_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('participant_session', n);
    DELETE FROM public.one_time_code_challenge
    WHERE (coalesce(consumed_at, invalidated_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('one_time_code_challenge', n);
    DELETE FROM public.activation_code c
    WHERE (coalesce(used_at, locked_at, revoked_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff
      AND NOT EXISTS (SELECT FROM public.participant_session s WHERE s.activation_code_id = c.id);
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('activation_code', n);
    DELETE FROM public.staff_session s
    WHERE (coalesce(ended_at, expires_at) AT TIME ZONE 'Europe/Berlin')::date <= p_cutoff
      AND NOT EXISTS (SELECT FROM public.assisted_mode a WHERE a.staff_session_hash = s.token_hash);
    GET DIAGNOSTICS n = ROW_COUNT; v := v || pg_catalog.jsonb_build_object('staff_session', n);
    IF r.dry_run THEN RAISE EXCEPTION 'retention_dry_run'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'retention_dry_run' THEN RAISE; END IF;
  END;
  RETURN v;
END $function$;

ALTER FUNCTION public.retention_purge_credentials(uuid,date) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_purge_credentials(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retention_purge_credentials(uuid,date) TO transfer_retention;
