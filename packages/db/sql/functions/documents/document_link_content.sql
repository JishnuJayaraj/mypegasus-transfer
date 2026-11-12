CREATE OR REPLACE FUNCTION public.document_link_content(p_link_hash text, p_session_kind public.document_session_kind, p_session_hash text)
 RETURNS TABLE(document_id uuid, participation_id uuid, document_type public.document_type, media_type public.document_media_type, file_name text, key_id text, wrapped_key bytea, added_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT d.id, d.participation_id, d.type, d.media_type, d.file_name, d.key_id, d.wrapped_key,
    d.added_at
  FROM public.document_link l
  JOIN public.document d ON d.id = l.document_id
  WHERE l.token_hash = p_link_hash AND l.session_kind = p_session_kind
    AND l.session_hash = p_session_hash AND l.expires_at > now() AND d.deleted_at IS NULL
    AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
    AND CASE p_session_kind
      WHEN 'participant' THEN EXISTS (
        SELECT FROM public.participant_session s
        WHERE s.token_hash = p_session_hash AND s.state = 'active'
          AND public.participant_session_live(s))
      ELSE EXISTS (
        SELECT FROM public.staff_session s
        JOIN public.staff_user u ON u.id = s.staff_user_id
        WHERE s.token_hash = p_session_hash AND s.ended_at IS NULL AND s.expires_at > now()
          AND u.deactivated_at IS NULL)
    END
$function$;

ALTER FUNCTION public.document_link_content(text,public.document_session_kind,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.document_link_content(text,public.document_session_kind,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_link_content(text,public.document_session_kind,text) TO transfer_app;
