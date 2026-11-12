CREATE OR REPLACE FUNCTION public.kug200b_member_problem(p_participation public.participation, p_document public.document, p_agentur_key text, p_outdated_versions text[], p_member public.kug200b_batch_member)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_channel public.asu_channel;
BEGIN
  IF p_document.id IS NULL OR p_document.type::text <> 'kug200b_signed_scan'
     OR p_document.participation_id IS DISTINCT FROM p_participation.id
     OR p_document.deleted_at IS NOT NULL OR p_document.review_state <> 'accepted'
     OR p_document.quarantined_at IS NOT NULL OR p_document.invalidated_by_correction IS NOT NULL
     OR p_document.form_version IS NULL THEN
    RETURN 'scan_unusable';
  END IF;
  IF p_participation.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RETURN 'participation_closed';
  END IF;
  IF p_participation.placement_agentur_key IS DISTINCT FROM p_agentur_key THEN
    RETURN 'placement_agentur_changed';
  END IF;
  SELECT channel INTO v_channel FROM public.asu_record WHERE participation_id = p_participation.id;
  IF p_member.batch_id IS NULL THEN
    IF EXISTS (SELECT FROM public.kug200b_batch_member m
               JOIN public.kug200b_batch b ON b.id = m.batch_id AND b.status = 'open'
               WHERE m.participation_id = p_participation.id AND m.active) THEN
      RETURN 'in_open_batch';
    END IF;
    IF EXISTS (SELECT FROM public.agentur_submission s
               WHERE s.participation_id = p_participation.id AND s.form_code = 'kug200b') THEN
      RETURN 'already_submitted';
    END IF;
    IF v_channel IS NULL THEN
      RETURN 'asu_route_unset';
    END IF;
  ELSIF v_channel IS DISTINCT FROM p_member.asu_channel THEN
    RETURN 'asu_route_changed';
  END IF;
  IF v_channel = 'kug_200b' AND EXISTS (
       SELECT FROM public.asu_registration WHERE participation_id = p_participation.id
         AND superseded_by IS NULL AND invalidated_by IS NULL) THEN
    RETURN 'asu_registered';
  END IF;
  IF p_document.form_version = ANY (p_outdated_versions) THEN
    RETURN 'form_version_outdated';
  END IF;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.kug200b_member_problem(public.participation,public.document,text,text[],public.kug200b_batch_member) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_member_problem(public.participation,public.document,text,text[],public.kug200b_batch_member) FROM PUBLIC;
