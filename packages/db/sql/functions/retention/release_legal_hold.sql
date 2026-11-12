CREATE OR REPLACE FUNCTION public.release_legal_hold(p_context public.audit_context, p_hold_id uuid, p_source text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  h public.legal_hold;
  p public.participation;
BEGIN
  IF p_hold_id IS NULL OR p_source IS NULL OR pg_catalog.char_length(p_source) NOT BETWEEN 1 AND 200
     OR p_source <> pg_catalog.btrim(p_source) OR p_source ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its participation never changes, so it can be read before the locks.
  SELECT * INTO h FROM public.legal_hold WHERE id = p_hold_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold_not_found'; END IF;
  PERFORM public.assert_context(p_context, h.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN RAISE EXCEPTION 'actor_not_allowed'; END IF;
  p := public.lock_participation(h.participation_id);
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project j ON j.id = p.project_id AND j.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  SELECT * INTO h FROM public.legal_hold WHERE id = p_hold_id FOR UPDATE;
  IF h.placed_by = (p_context).staff_user_id THEN RAISE EXCEPTION 'four_eyes'; END IF;
  IF h.released_at IS NOT NULL THEN RAISE EXCEPTION 'hold_released'; END IF;
  UPDATE public.legal_hold SET released_at = pg_catalog.now(),
    released_by = (p_context).staff_user_id, release_source = p_source
  WHERE id = h.id;
  PERFORM public.write_audit_event(p.project_id, p.id, 'legal_hold_released', p_context, NULL,
    NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('holdId', h.id), false);
  RETURN h.id;
END $function$;

ALTER FUNCTION public.release_legal_hold(public.audit_context,uuid,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.release_legal_hold(public.audit_context,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_legal_hold(public.audit_context,uuid,text) TO transfer_app;
