CREATE OR REPLACE FUNCTION public.close_assisted_mode(m public.assisted_mode, p_reason public.assisted_mode_end_reason, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.assisted_mode SET ended_at = greatest(now(), m.started_at), end_reason = p_reason
  WHERE id = m.id AND ended_at IS NULL;
  PERFORM public.write_audit_event(m.project_id, m.participation_id, 'assisted_mode_ended',
    ROW('user', m.staff_user_id, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('assistedModeId', m.id,
      'endReason', p_reason), false);
END $function$;

ALTER FUNCTION public.close_assisted_mode(public.assisted_mode,public.assisted_mode_end_reason,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.close_assisted_mode(public.assisted_mode,public.assisted_mode_end_reason,text) FROM PUBLIC;
