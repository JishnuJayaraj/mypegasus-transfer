CREATE OR REPLACE FUNCTION public.profiler_may_read(p_participation_id uuid, p_context public.audit_context)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL
    AND 'consultant' = ANY (public.document_staff_roles(p_participation_id,
      (p_context).staff_user_id))
$function$;

ALTER FUNCTION public.profiler_may_read(uuid,public.audit_context) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.profiler_may_read(uuid,public.audit_context) FROM PUBLIC;
