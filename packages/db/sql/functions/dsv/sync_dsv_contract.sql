CREATE OR REPLACE FUNCTION public.sync_dsv_contract(p_offer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE o public.dsv_offer; a record; b record;
BEGIN
  SELECT * INTO o FROM public.dsv_offer WHERE id = p_offer_id AND ended_as = 'signed';
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.dsv_contract(project_id, participation_id, dsv_offer_id)
  VALUES (o.project_id, o.participation_id, o.id) ON CONFLICT (dsv_offer_id) DO NOTHING;
  PERFORM FROM public.dsv_contract WHERE dsv_offer_id = o.id FOR UPDATE;
  SELECT f.signed_on, d.reviewed_at, d.reviewed_by, d.dsv_received_on, d.dsv_received_by INTO a
  FROM public.dsv_facts(ARRAY[o.participation_id]) f JOIN public.document d ON d.id = f.document_id
  WHERE f.offer_id = o.id ORDER BY f.recorded_at, f.document_id LIMIT 1;
  SELECT f.customer_signed_on, f.tg_signed_on, f.executed_on, d.reviewed_at, d.reviewed_by INTO b
  FROM public.dsv_facts(ARRAY[o.participation_id]) f JOIN public.document d ON d.id = f.document_id
  WHERE f.offer_id = o.id AND f.executed_on IS NOT NULL ORDER BY f.recorded_at, f.document_id LIMIT 1;
  UPDATE public.dsv_contract c SET
    participant_signed_on = coalesce(c.participant_signed_on, a.signed_on),
    participant_accepted_on = coalesce(c.participant_accepted_on,
      (a.reviewed_at AT TIME ZONE 'Europe/Berlin')::date),
    participant_accepted_by_role = coalesce(c.participant_accepted_by_role,
      public.dsv_role_kind(o.participation_id, a.reviewed_by)),
    received_on = coalesce(c.received_on, a.dsv_received_on),
    received_by_role = coalesce(c.received_by_role,
      public.dsv_role_kind(o.participation_id, a.dsv_received_by)),
    customer_signed_on = coalesce(c.customer_signed_on, b.customer_signed_on),
    tg_signed_on = coalesce(c.tg_signed_on, b.tg_signed_on),
    fully_executed_on = coalesce(c.fully_executed_on, b.executed_on),
    fully_executed_accepted_on = coalesce(c.fully_executed_accepted_on,
      (b.reviewed_at AT TIME ZONE 'Europe/Berlin')::date),
    fully_executed_accepted_by_role = coalesce(c.fully_executed_accepted_by_role,
      public.dsv_role_kind(o.participation_id, b.reviewed_by))
  WHERE c.dsv_offer_id = o.id;
END $function$;

ALTER FUNCTION public.sync_dsv_contract(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.sync_dsv_contract(uuid) FROM PUBLIC;
