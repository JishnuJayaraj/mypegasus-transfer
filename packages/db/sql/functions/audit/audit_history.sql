CREATE OR REPLACE FUNCTION public.audit_history(p_staff_session_hash text, p_participation_id uuid, p_before_seq bigint, p_limit integer, p_request_id text DEFAULT NULL::text)
 RETURNS TABLE(seq bigint, occurred_at timestamp with time zone, event_type public.audit_event_type, actor_type public.actor_type, actor_name text, system_job text, on_behalf boolean, field public.status_field, from_value text, to_value text, reason_code text, effective_date date, details jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_staff uuid;
  v_project uuid;
  v_roles text[];
  v_streams public.audit_stream[] := '{}';
  v_own public.audit_stream[] := '{}';
  v_known public.access_category[];
BEGIN
  IF p_participation_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_before_seq < 1 OR p_request_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT s.staff_user_id INTO v_staff
  FROM public.staff_session s
  JOIN public.staff_user u ON u.id = s.staff_user_id AND u.deactivated_at IS NULL
  WHERE s.token_hash = p_staff_session_hash AND s.ended_at IS NULL AND s.expires_at > now();
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  SELECT p.project_id INTO v_project FROM public.participation p WHERE p.id = p_participation_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF NOT EXISTS (SELECT FROM public.project_membership m
                 WHERE m.project_id = v_project AND m.staff_user_id = v_staff) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  -- The current memberships, the consultant only while assigned.
  v_roles := public.document_staff_roles(p_participation_id, v_staff);
  IF 'project_lead' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling,dsv}'::public.audit_stream[];
  END IF;
  IF 'consultant' = ANY (v_roles) THEN
    v_streams := v_streams || '{case,profiling}'::public.audit_stream[];
    v_own := '{dsv,payroll}';
  END IF;
  IF 'back_office' = ANY (v_roles) THEN
    v_streams := v_streams || '{dsv,payroll}'::public.audit_stream[];
  END IF;
  IF pg_catalog.cardinality(v_streams) = 0 THEN
    RAISE EXCEPTION 'not_assigned';
  END IF;
  v_known := ARRAY(SELECT DISTINCT k.access_category FROM public.role_field_knowledge k
                   WHERE k.project_role::text = ANY (v_roles));

  IF p_before_seq IS NULL THEN
    PERFORM public.write_audit_event(v_project, p_participation_id, 'audit_history_opened',
      ROW('user', v_staff, NULL, NULL, NULL, p_request_id, NULL)::public.audit_context, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb, false);
  END IF;

  RETURN QUERY
  SELECT e.seq, e.occurred_at, e.event_type, e.actor_type,
    CASE WHEN e.actor_type = 'user' THEN u.display_name END,
    e.system_job,
    e.on_behalf_of_participation_id IS NOT NULL,
    CASE WHEN pr.shows_change THEN e.field END,
    CASE WHEN pr.shows_change THEN e.from_value END,
    CASE WHEN pr.shows_change THEN e.to_value END,
    CASE WHEN pr.shows_reason THEN e.reason_code END,
    e.effective_date,
    public.audit_history_details(e.details, pr.detail_keys, v_known)
  FROM public.audit_event e
  JOIN public.audit_event_projection pr ON pr.event_type = e.event_type::text
    AND pr.field IS NOT DISTINCT FROM
      CASE WHEN e.event_type::text = 'status_changed' THEN e.field END
  LEFT JOIN public.staff_user u ON u.id = e.actor_staff_user_id
  WHERE e.participation_id = p_participation_id AND e.project_id = v_project
    AND (p_before_seq IS NULL OR e.seq < p_before_seq)
    AND ((CASE WHEN e.details->>'documentType' IN ('dsv_signed_scan', 'dsv_cancellation') THEN 'dsv'::public.audit_stream ELSE pr.stream END) = ANY (v_streams)
         OR (CASE WHEN e.details->>'documentType' IN ('dsv_signed_scan', 'dsv_cancellation') THEN 'dsv'::public.audit_stream ELSE pr.stream END) = ANY (v_own) AND e.actor_staff_user_id = v_staff)
  ORDER BY e.seq DESC
  LIMIT p_limit;
END $function$;

ALTER FUNCTION public.audit_history(text,uuid,bigint,integer,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.audit_history(text,uuid,bigint,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_history(text,uuid,bigint,integer,text) TO transfer_app;
