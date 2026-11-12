CREATE OR REPLACE FUNCTION public.offer_dsv(p_context public.audit_context, p_participation_id uuid, p_generation_id uuid, p_external jsonb, p_expected_status_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r public.participation;
  g public.form_generation;
  w public.project_entry_wave;
  v_id uuid := gen_random_uuid();
  v_event uuid;
  v_deadline date;
  v_start date;
  v_end date;
  v_version text;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  r := public.lock_participation(p_participation_id);
  IF (p_context).on_behalf_of IS NOT NULL OR NOT public.document_staff_roles(r.id,
      (p_context).staff_user_id) && '{project_lead,back_office}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF r.status_version IS DISTINCT FROM p_expected_status_version THEN RAISE EXCEPTION 'stale_status'; END IF;
  IF r.status <> 'informed' OR (SELECT type FROM public.project WHERE id = r.project_id) <> 'ta_tg' THEN
    RAISE EXCEPTION 'track_inactive';
  END IF;
  IF r.dsv_status NOT IN ('not_offered', 'dsv_declined', 'dsv_expired') THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF (p_generation_id IS NULL) = (p_external IS NULL) THEN RAISE EXCEPTION 'invalid_argument'; END IF;
  SELECT * INTO w FROM public.project_entry_wave WHERE id = r.entry_wave_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wave_required'; END IF;
  v_start := coalesce(r.tg_start, w.default_tg_start);
  v_end := coalesce(r.tg_end, w.default_tg_end);
  IF p_generation_id IS NOT NULL THEN
    SELECT * INTO g FROM public.form_generation WHERE id = p_generation_id
      AND participation_id = r.id AND form_code::text = 'dsv' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'generation_not_found'; END IF;
    IF NOT public.dsv_generation_current(g.id, g.organisation_sha256)
       OR EXISTS (SELECT FROM public.dsv_offer WHERE participation_id = r.id AND ended_at >= g.generated_at)
       OR EXISTS (SELECT FROM public.document WHERE id = g.document_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'source_changed';
    END IF;
    v_deadline := g.offer_deadline;
    v_version := g.form_version;
  ELSE
    v_deadline := (p_external->>'deadline')::date;
    IF (p_external->>'printedTgStart')::date IS DISTINCT FROM v_start
       OR (p_external->>'printedTgEnd')::date IS DISTINCT FROM v_end THEN
      RAISE EXCEPTION 'terms_mismatch';
    END IF;
    v_version := 'external_unknown';
  END IF;
  IF v_deadline IS NULL OR v_start IS NULL OR v_end IS NULL OR w.latest_entry_date IS NULL
     OR v_deadline < (now() AT TIME ZONE 'Europe/Berlin')::date
     OR v_deadline > v_start OR v_deadline > w.latest_entry_date THEN
    RAISE EXCEPTION 'offer_deadline_invalid';
  END IF;
  INSERT INTO public.dsv_offer(id, project_id, participation_id, generation_id, origin,
    template_version, offer_deadline, printed_tg_start, printed_tg_end, offered_by)
  VALUES(v_id, r.project_id, r.id, p_generation_id,
    CASE WHEN p_generation_id IS NULL THEN 'external_paper' ELSE 'generated' END,
    v_version, v_deadline, v_start, v_end, (p_context).staff_user_id);
  v_event := public.apply_status_change(r.id, 'dsv_status', r.dsv_status::text,
    'dsv_offered', p_context, p_offer_deadline => v_deadline);
  UPDATE public.dsv_offer SET status_event_id = v_event WHERE id = v_id;
  RETURN v_id;
END $function$;

ALTER FUNCTION public.offer_dsv(public.audit_context,uuid,uuid,jsonb,integer) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.offer_dsv(public.audit_context,uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.offer_dsv(public.audit_context,uuid,uuid,jsonb,integer) TO transfer_app;
