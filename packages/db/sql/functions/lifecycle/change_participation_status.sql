CREATE OR REPLACE FUNCTION public.change_participation_status(p_id uuid, p_field public.status_field, p_expected_from text, p_to text, p_context public.audit_context, p_entry_kind public.tg_entry_kind DEFAULT NULL::public.tg_entry_kind, p_end_reason public.end_reason DEFAULT NULL::public.end_reason, p_secondary_reasons public.end_reason[] DEFAULT '{}'::public.end_reason[], p_offer_deadline date DEFAULT NULL::date, p_effective_date date DEFAULT NULL::date, p_scheduled_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_context(p_context, p_id, '{user,system}');
  RETURN public.apply_status_change(p_id, p_field, p_expected_from, p_to, p_context, p_entry_kind,
    p_end_reason, p_secondary_reasons, p_offer_deadline, p_effective_date, p_scheduled_at, false);
END $function$;

ALTER FUNCTION public.change_participation_status(uuid,public.status_field,text,text,public.audit_context,public.tg_entry_kind,public.end_reason,public.end_reason[],date,date,timestamp with time zone) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.change_participation_status(uuid,public.status_field,text,text,public.audit_context,public.tg_entry_kind,public.end_reason,public.end_reason[],date,date,timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_participation_status(uuid,public.status_field,text,text,public.audit_context,public.tg_entry_kind,public.end_reason,public.end_reason[],date,date,timestamp with time zone) TO transfer_app;
