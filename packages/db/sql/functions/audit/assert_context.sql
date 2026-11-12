CREATE OR REPLACE FUNCTION public.assert_context(p_context public.audit_context, p_participation_id uuid, p_allowed public.actor_type[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- Fails closed: an unknown actor or a missing allow-list (e.g. no creation edge) is refused.
  IF NOT coalesce(p_context.actor_type = ANY (p_allowed), false) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  -- Assisted mode and participant actors act for this participation only.
  IF p_context.on_behalf_of IS DISTINCT FROM NULL AND p_context.on_behalf_of IS DISTINCT FROM p_participation_id
     OR p_context.actor_type = 'participant' AND p_context.participation_id IS DISTINCT FROM p_participation_id THEN
    RAISE EXCEPTION 'invalid_actor';
  END IF;
END $function$;

ALTER FUNCTION public.assert_context(public.audit_context,uuid,public.actor_type[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_context(public.audit_context,uuid,public.actor_type[]) FROM PUBLIC;
