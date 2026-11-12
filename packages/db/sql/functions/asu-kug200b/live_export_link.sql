CREATE OR REPLACE FUNCTION public.live_export_link(p_context public.audit_context, p_link_hash text, p_session_hash text)
 RETURNS public.export_link
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  l public.export_link;
BEGIN
  IF p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$'
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  SELECT * INTO l FROM public.export_link e
  WHERE e.token_hash = p_link_hash AND e.session_hash = p_session_hash
    AND e.staff_user_id = (p_context).staff_user_id AND e.expires_at > now()
    AND (p_context).on_behalf_of IS NULL
    AND EXISTS (
      SELECT FROM public.staff_session s
      JOIN public.staff_user u ON u.id = s.staff_user_id
      WHERE s.token_hash = p_session_hash AND s.staff_user_id = e.staff_user_id
        AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_link_invalid';
  END IF;
  RETURN l;
END $function$;

ALTER FUNCTION public.live_export_link(public.audit_context,text,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.live_export_link(public.audit_context,text,text) FROM PUBLIC;
