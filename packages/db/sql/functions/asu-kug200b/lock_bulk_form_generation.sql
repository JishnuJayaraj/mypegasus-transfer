CREATE OR REPLACE FUNCTION public.lock_bulk_form_generation(p_context public.audit_context, p_project_id uuid, p_participation_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_project_id IS NULL OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 100
     OR (SELECT pg_catalog.count(DISTINCT i) FROM pg_catalog.unnest(p_participation_ids) i)
       <> pg_catalog.cardinality(p_participation_ids)
     OR pg_catalog.array_position(p_participation_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL OR NOT EXISTS (
    SELECT FROM public.project_membership m
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE m.project_id = p_project_id AND m.staff_user_id = (p_context).staff_user_id
      AND m.role = 'project_lead') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (SELECT type FROM public.project WHERE id = p_project_id) IS DISTINCT FROM 'ta_tg' THEN
    RAISE EXCEPTION 'asu_not_applicable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(p_project_id));
  IF (SELECT pg_catalog.count(*) FROM public.participation
      WHERE id = ANY (p_participation_ids) AND project_id = p_project_id)
     <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  PERFORM FROM public.participation WHERE id = ANY (p_participation_ids) ORDER BY id FOR UPDATE;
END $function$;

ALTER FUNCTION public.lock_bulk_form_generation(public.audit_context,uuid,uuid[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.lock_bulk_form_generation(public.audit_context,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_bulk_form_generation(public.audit_context,uuid,uuid[]) TO transfer_app;
