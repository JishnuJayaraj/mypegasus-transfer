CREATE OR REPLACE FUNCTION public.write_audit_event(p_project_id uuid, p_participation_id uuid, p_event_type public.audit_event_type, p_context public.audit_context, p_field public.status_field, p_from text, p_to text, p_reason_code text, p_effective_date date, p_details jsonb, p_flagged_for_review boolean)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  INSERT INTO public.audit_event (
    project_id, participation_id, event_type, actor_type, actor_staff_user_id,
    actor_participation_id, system_job, on_behalf_of_participation_id, field, from_value, to_value,
    reason_code, effective_date, request_id, job_id, details, flagged_for_review
  ) VALUES (
    p_project_id, p_participation_id, p_event_type, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).participation_id, (p_context).system_job, (p_context).on_behalf_of, p_field, p_from, p_to,
    p_reason_code, p_effective_date, (p_context).request_id, (p_context).job_id,
    coalesce(p_details, '{}'), p_flagged_for_review
  ) RETURNING id
$function$;

ALTER FUNCTION public.write_audit_event(uuid,uuid,public.audit_event_type,public.audit_context,public.status_field,text,text,text,date,jsonb,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.write_audit_event(uuid,uuid,public.audit_event_type,public.audit_context,public.status_field,text,text,text,date,jsonb,boolean) FROM PUBLIC;
