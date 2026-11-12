CREATE OR REPLACE FUNCTION public.set_funding_status(p_context public.audit_context, p_participation_id uuid, p_funded110 public.funded110, p_source text, p_expected_funded110 public.funded110, p_expected_source text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  r := public.lock_participation(p_participation_id);
  IF NOT public.document_staff_roles(r.id, (p_context).staff_user_id) && '{back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (r.funded110, r.funded110_source) IS DISTINCT FROM (p_expected_funded110, p_expected_source) THEN
    RAISE EXCEPTION 'stale_funding';
  END IF;
  IF p_funded110 IS NULL OR p_source IS NULL OR pg_catalog.char_length(p_source) NOT BETWEEN 1 AND 200
     OR p_source <> pg_catalog.btrim(p_source) OR p_source ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_funded110, p_source) IS NOT DISTINCT FROM (r.funded110, r.funded110_source) THEN
    RAISE EXCEPTION 'funding_unchanged';
  END IF;
  UPDATE public.participation SET funded110 = p_funded110, funded110_source = p_source,
    funded110_set_by = (p_context).staff_user_id, funded110_set_at = pg_catalog.now()
  WHERE id = r.id;
  RETURN public.write_audit_event(r.project_id, r.id, 'funding_status_set', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('funded110', p_funded110), false);
END $function$;

ALTER FUNCTION public.set_funding_status(public.audit_context,uuid,public.funded110,text,public.funded110,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.set_funding_status(public.audit_context,uuid,public.funded110,text,public.funded110,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_funding_status(public.audit_context,uuid,public.funded110,text,public.funded110,text) TO transfer_app;
