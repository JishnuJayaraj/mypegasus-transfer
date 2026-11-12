CREATE OR REPLACE FUNCTION public.request_reminders(p_context public.audit_context, p_project_id uuid, p_participation_ids uuid[], p_kind public.reminder_kind, p_message_version text, p_batch_id uuid)
 RETURNS TABLE(participation_id uuid, reminder_id uuid, channel_kind public.contact_channel_kind, skip text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_staff uuid := (p_context).staff_user_id;
  v_roles text[];
  v_today date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_id uuid;
  p public.participation;
  ch record;
  v_reminder uuid;
BEGIN
  IF p_project_id IS NULL OR p_kind IS DISTINCT FROM 'open_items' OR p_batch_id IS NULL
     OR p_message_version IS DISTINCT FROM 'portal-reminder:v1'
     OR p_participation_ids IS NULL
     OR pg_catalog.cardinality(p_participation_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_participation_ids, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM unnest(p_participation_ids) x)
        <> pg_catalog.cardinality(p_participation_ids) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.assert_context(p_context, NULL, '{user}');
  PERFORM public.lock_project_setup(p_project_id);
  IF EXISTS (SELECT FROM unnest(p_participation_ids) x
             WHERE NOT EXISTS (SELECT FROM public.participation q
                               WHERE q.id = x AND q.project_id = p_project_id)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  v_roles := public.appointment_member_roles(p_project_id, v_staff);
  IF NOT v_roles && '{project_lead,consultant}'::text[] THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF NOT 'project_lead' = ANY (v_roles) AND EXISTS (
    SELECT FROM unnest(p_participation_ids) x
    WHERE NOT EXISTS (SELECT FROM public.participant_assignment a
                      WHERE a.participation_id = x AND a.staff_user_id = v_staff
                        AND a.ended_at IS NULL)) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  IF (SELECT status FROM public.project WHERE id = p_project_id) <> 'active' THEN
    RAISE EXCEPTION 'project_not_active';
  END IF;

  FOREACH v_id IN ARRAY p_participation_ids LOOP
    p := public.lock_participation(v_id);
    participation_id := v_id;
    reminder_id := NULL;
    channel_kind := NULL;
    skip := NULL;
    IF p.status IN ('withdrawn', 'ta_completed', 'exited') THEN
      skip := 'participation_closed';
    ELSIF NOT EXISTS (SELECT FROM public.participant_channel c
                      WHERE c.participation_id = v_id AND c.removed_at IS NULL
                        AND c.suspended_at IS NULL) THEN
      skip := 'no_channel';
    ELSE
      SELECT c.id, c.kind, c.consent_id INTO ch
      FROM public.participant_channel c
      JOIN public.consent_record k ON k.id = c.consent_id
      WHERE c.participation_id = v_id AND c.removed_at IS NULL AND c.suspended_at IS NULL
        AND k.purpose = 'portal_contact' AND k.text_version = 'portal-contact-consent:v2'
        AND k.ended_at IS NULL
      ORDER BY c.kind = 'email' DESC, c.verified_at DESC, c.id
      LIMIT 1;
      IF NOT FOUND THEN
        skip := 'consent_required';
      ELSIF EXISTS (SELECT FROM public.participant_reminder r
                    WHERE r.participation_id = v_id AND r.kind = 'open_items'
                      AND r.requested_on > v_today - 3) THEN
        skip := 'reminded_recently';
      ELSE
        v_reminder := gen_random_uuid();
        INSERT INTO public.participant_reminder (id, project_id, participation_id, batch_id, kind,
          message_version, language, channel_id, channel_kind, consent_id, requested_by,
          requested_on)
        SELECT v_reminder, p.project_id, v_id, p_batch_id, p_kind, p_message_version, a.language,
          ch.id, ch.kind, ch.consent_id, v_staff, v_today
        FROM public.participant_account a WHERE a.participation_id = v_id;
        PERFORM public.write_audit_event(p.project_id, v_id, 'reminder_queued', p_context, NULL,
          NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('reminderId', v_reminder,
            'batchId', p_batch_id, 'kind', p_kind, 'channelKind', ch.kind), false);
        reminder_id := v_reminder;
        channel_kind := ch.kind;
      END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END $function$;

ALTER FUNCTION public.request_reminders(public.audit_context,uuid,uuid[],public.reminder_kind,text,uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.request_reminders(public.audit_context,uuid,uuid[],public.reminder_kind,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_reminders(public.audit_context,uuid,uuid[],public.reminder_kind,text,uuid) TO transfer_app;
