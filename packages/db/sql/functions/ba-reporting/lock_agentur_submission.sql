CREATE OR REPLACE FUNCTION public.lock_agentur_submission(p_context public.audit_context, p_submission_id uuid)
 RETURNS public.agentur_submission
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_participation_id uuid;
  s public.agentur_submission;
BEGIN
  -- participation_id never changes, so it can be read before the lock.
  SELECT participation_id INTO v_participation_id FROM public.agentur_submission
  WHERE id = p_submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.lock_participation(v_participation_id);
  IF NOT 'project_lead' = ANY (public.document_staff_roles(v_participation_id,
      (p_context).staff_user_id)) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO s FROM public.agentur_submission WHERE id = p_submission_id FOR UPDATE;
  RETURN s;
END $function$;

ALTER FUNCTION public.lock_agentur_submission(public.audit_context,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_agentur_submission(public.audit_context,uuid) FROM PUBLIC;
