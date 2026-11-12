CREATE OR REPLACE FUNCTION public.kug200b_batch_export_content(p_context public.audit_context, p_link_hash text, p_session_hash text)
 RETURNS TABLE(participation_id uuid, document_id uuid, last_name text, first_name text, form_version text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
  b public.kug200b_batch;
  m public.kug200b_batch_member;
  r public.participation;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.batch_id IS NULL OR l.kind::text <> 'kug200b_batch_index' THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(l.project_id));
  SELECT * INTO b FROM public.kug200b_batch WHERE id = l.batch_id;
  IF NOT public.kug200b_batch_lead(b.project_id, l.staff_user_id) OR b.status <> 'open' THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = b.id LOOP
    SELECT * INTO r FROM public.participation WHERE id = m.participation_id;
    SELECT * INTO d FROM public.document WHERE id = m.document_id;
    IF public.kug200b_member_problem(r, d, b.agentur_key, '{}', m) IS NOT NULL THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', b.member_count), false);
  RETURN QUERY
    SELECT m2.participation_id, m2.document_id, i.last_name, i.first_name, m2.form_version
    FROM public.kug200b_batch_member m2
    LEFT JOIN public.participant_identity i ON i.participation_id = m2.participation_id
    WHERE m2.batch_id = b.id
    ORDER BY i.last_name, i.first_name, m2.participation_id;
END $function$;

ALTER FUNCTION public.kug200b_batch_export_content(public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_export_content(public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kug200b_batch_export_content(public.audit_context,text,text) TO transfer_app;
