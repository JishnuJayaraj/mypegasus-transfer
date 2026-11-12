CREATE OR REPLACE FUNCTION public.assisted_mode_roles(p_participation_id uuid, p_staff_user_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT m.role::text
    FROM public.participation p
    JOIN public.project_membership m
      ON m.project_id = p.project_id AND m.staff_user_id = p_staff_user_id
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE p.id = p_participation_id
      AND (m.role IN ('project_lead', 'back_office') OR m.role = 'consultant' AND EXISTS (
        SELECT FROM public.participant_assignment a
        WHERE a.participation_id = p.id AND a.staff_user_id = m.staff_user_id
          AND a.ended_at IS NULL))
    ORDER BY 1)
$function$;

ALTER FUNCTION public.assisted_mode_roles(uuid,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assisted_mode_roles(uuid,uuid) FROM PUBLIC;
