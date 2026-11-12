CREATE OR REPLACE FUNCTION public.export_link_content(p_context public.audit_context, p_link_hash text, p_session_hash text)
 RETURNS TABLE(document_id uuid, participation_id uuid, document_type public.document_type, key_id text, wrapped_key bytea)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
  d public.document;
BEGIN
  l := public.live_export_link(p_context, p_link_hash, p_session_hash);
  IF l.kind::text <> 'kug200b_print' THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  FOR d IN SELECT x.* FROM public.document x WHERE x.id = ANY (l.document_ids) LOOP
    IF NOT public.export_document_allowed(d, l.staff_user_id) THEN
      RAISE EXCEPTION 'export_stale';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM public.document x WHERE x.id = ANY (l.document_ids))
     <> pg_catalog.cardinality(l.document_ids) THEN
    RAISE EXCEPTION 'export_stale';
  END IF;
  PERFORM public.write_audit_event(l.project_id, NULL, 'export_downloaded', p_context, NULL, NULL,
    NULL, NULL, NULL, pg_catalog.jsonb_build_object('exportKind', l.kind,
      'count', pg_catalog.cardinality(l.document_ids)), false);
  RETURN QUERY
    SELECT x.id, x.participation_id, x.type, x.key_id, x.wrapped_key
    FROM pg_catalog.unnest(l.document_ids) WITH ORDINALITY AS u(id, ord)
    JOIN public.document x ON x.id = u.id
    ORDER BY u.ord;
END $function$;

ALTER FUNCTION public.export_link_content(public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.export_link_content(public.audit_context,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_link_content(public.audit_context,text,text) TO transfer_app;
