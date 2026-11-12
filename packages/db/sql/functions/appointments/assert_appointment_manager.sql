CREATE OR REPLACE FUNCTION public.assert_appointment_manager(p_project_id uuid, p_staff uuid, p_kind public.appointment_kind, p_host uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_roles text[] := public.appointment_member_roles(p_project_id, p_staff);
BEGIN
  IF NOT ('project_lead' = ANY (v_roles)
          OR 'consultant' = ANY (v_roles) AND p_kind = 'consultation' AND p_host = p_staff) THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  RETURN v_roles;
END $function$;

ALTER FUNCTION public.assert_appointment_manager(uuid,uuid,public.appointment_kind,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_appointment_manager(uuid,uuid,public.appointment_kind,uuid) FROM PUBLIC;
