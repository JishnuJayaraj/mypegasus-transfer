CREATE OR REPLACE FUNCTION public.revoke_activation_code(p_activation_code_id uuid, p_reason public.activation_revoke_reason, p_context public.audit_context)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c public.activation_code;
BEGIN
  SELECT * INTO c FROM public.activation_code WHERE id = p_activation_code_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation_code_not_found'; END IF;
  PERFORM public.assert_activation_actor(c.project_id, p_context);
  IF p_reason NOT IN ('not_handed_over', 'lost') THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  IF c.revoked_at IS NOT NULL OR c.locked_at IS NOT NULL OR c.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'activation_code_not_open';
  END IF;
  IF p_reason = 'not_handed_over' AND (c.channel <> 'sheet' OR c.handed_over_at IS NOT NULL) THEN
    RAISE EXCEPTION 'handover_not_allowed';
  END IF;
  UPDATE public.activation_code SET revoked_by = (p_context).staff_user_id,
    revoked_at = now(), revoke_reason = p_reason WHERE id = c.id;
  PERFORM public.write_audit_event(c.project_id, c.participation_id, 'activation_code_revoked',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('activationCodeId', c.id), false);
END $function$;

ALTER FUNCTION public.revoke_activation_code(uuid,public.activation_revoke_reason,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.revoke_activation_code(uuid,public.activation_revoke_reason,public.audit_context) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_activation_code(uuid,public.activation_revoke_reason,public.audit_context) TO transfer_app;
