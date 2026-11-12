CREATE OR REPLACE FUNCTION public.kug200b_batch_export_sources(p_batch public.kug200b_batch, p_kind text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE p_kind
    WHEN 'kug200b_batch_scans' THEN pg_catalog.jsonb_build_object('members', (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'participationId', m.participation_id, 'documentId', d.id,
          'mediaType', d.media_type, 'contentSha256', d.content_sha256)
        ORDER BY i.last_name, i.first_name, m.participation_id)
      FROM public.kug200b_batch_member m
      JOIN public.document d ON d.id = m.document_id
      LEFT JOIN public.participant_identity i ON i.participation_id = m.participation_id
      WHERE m.batch_id = p_batch.id))
    ELSE pg_catalog.jsonb_build_object(
      'project', (SELECT pg_catalog.jsonb_build_object('customerName', p.customer_name,
          'tKugNumber', p.t_kug_number, 'employerBetriebsnummer', p.employer_betriebsnummer,
          'employerEconomicClass', p.employer_economic_class)
        FROM public.project p WHERE p.id = p_batch.project_id),
      'createdOn', pg_catalog.to_char(p_batch.created_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD'),
      'members', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'participationId', m.participation_id, 'documentId', m.document_id,
            'firstName', i.first_name, 'lastName', i.last_name,
            'address', CASE WHEN pd.address_street IS NOT NULL THEN pg_catalog.jsonb_build_object(
              'street', pd.address_street, 'postalCode', pd.address_postal_code,
              'city', pd.address_city, 'country', pd.address_country) END,
            'insuranceNumberSha256', pg_catalog.encode(
              pg_catalog.sha256(x.pension_insurance_number), 'hex'),
            'tgStart', pg_catalog.to_char(coalesce(r.tg_start, w.default_tg_start), 'YYYY-MM-DD'),
            'tgEnd', pg_catalog.to_char(coalesce(r.tg_end, w.default_tg_end), 'YYYY-MM-DD'),
            'declaration17', coalesce((
              SELECT CASE WHEN c.document_id = m.document_id THEN 'in_packet'
                ELSE 'other_paper' END
              FROM public.consent_record c
              JOIN public.document cd ON cd.id = c.document_id
              WHERE c.participation_id = m.participation_id
                AND c.purpose::text = 'kug200b_profile_access' AND c.ended_at IS NULL
                AND cd.deleted_at IS NULL AND cd.quarantined_at IS NULL
                AND cd.invalidated_by_correction IS NULL
              ORDER BY c.document_id = m.document_id DESC LIMIT 1), 'none'),
            'infoEventDates', coalesce((
              SELECT pg_catalog.jsonb_agg(DISTINCT pg_catalog.to_char(
                  a.starts_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD'))
              FROM public.appointment_booking k
              JOIN public.appointment a ON a.id = k.appointment_id
              WHERE k.participation_id = m.participation_id AND k.status::text = 'booked'
                AND k.attendance::text = 'attended' AND a.kind::text = 'info_event'
                AND a.status::text = 'scheduled' AND a.project_id = p_batch.project_id), '[]'))
          ORDER BY i.last_name, i.first_name, m.participation_id)
        FROM public.kug200b_batch_member m
        JOIN public.participation r ON r.id = m.participation_id
        LEFT JOIN public.project_entry_wave w ON w.id = r.entry_wave_id
        LEFT JOIN public.participant_identity i ON i.participation_id = m.participation_id
        LEFT JOIN public.participant_details pd ON pd.participation_id = m.participation_id
        LEFT JOIN public.participant_identifier_data x ON x.participation_id = m.participation_id
        WHERE m.batch_id = p_batch.id))
  END
$function$;

ALTER FUNCTION public.kug200b_batch_export_sources(public.kug200b_batch,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_export_sources(public.kug200b_batch,text) FROM PUBLIC;
