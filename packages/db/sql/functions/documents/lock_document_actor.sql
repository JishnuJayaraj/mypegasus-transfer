CREATE OR REPLACE FUNCTION public.lock_document_actor(p_participation_id uuid, p_context public.audit_context, p_token_hash text, p_open boolean)
 RETURNS text[]
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.participation; s public.participant_session;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF p_open AND r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    RETURN '{participant}';
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RETURN public.lock_assisted_mode(p_participation_id, p_context, p_token_hash);
  END IF;
  RETURN public.document_staff_roles(p_participation_id, (p_context).staff_user_id);
END $function$;

ALTER FUNCTION public.lock_document_actor(uuid,public.audit_context,text,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_document_actor(uuid,public.audit_context,text,boolean) FROM PUBLIC;
