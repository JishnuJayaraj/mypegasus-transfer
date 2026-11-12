CREATE OR REPLACE FUNCTION public.record_clarification_instruction(p_context public.audit_context, p_clarification_id uuid, p_code text, p_source text, p_status_version integer, p_expected_revision integer)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT public.answer_entry_clarification(p_context, p_clarification_id, 'instructed', p_code,
    p_source, p_status_version, p_expected_revision)
$function$;

ALTER FUNCTION public.record_clarification_instruction(public.audit_context,uuid,text,text,integer,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.record_clarification_instruction(public.audit_context,uuid,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_clarification_instruction(public.audit_context,uuid,text,text,integer,integer) TO transfer_app;
