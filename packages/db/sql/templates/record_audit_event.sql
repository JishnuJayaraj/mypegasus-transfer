CREATE OR REPLACE FUNCTION public.record_audit_event(p_project_id uuid, p_participation_id uuid, p_event_type public.audit_event_type, p_context public.audit_context, p_reason_code text DEFAULT NULL::text, p_effective_date date DEFAULT NULL::date, p_details jsonb DEFAULT '{}'::jsonb, p_flagged_for_review boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_event_type::text IN (
      /*generated:reserved_event_types*/
  ) THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context,
    NULL, NULL, NULL, p_reason_code, p_effective_date, p_details,
    coalesce(p_flagged_for_review, false));
END $function$;

ALTER FUNCTION public.record_audit_event(uuid,uuid,public.audit_event_type,public.audit_context,text,date,jsonb,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_audit_event(uuid,uuid,public.audit_event_type,public.audit_context,text,date,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_audit_event(uuid,uuid,public.audit_event_type,public.audit_context,text,date,jsonb,boolean) TO transfer_app;
