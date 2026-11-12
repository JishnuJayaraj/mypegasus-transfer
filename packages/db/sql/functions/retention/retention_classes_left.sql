CREATE OR REPLACE FUNCTION public.retention_classes_left(p_participation_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT ARRAY(SELECT c FROM (VALUES
    ('participation_record', true),
    ('personnel_file',
      EXISTS (SELECT FROM public.participant_details WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profile WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_residence_social_data WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling_assessment WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.self_service_notice_acknowledgement WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.privacy_notice_delivery WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_account WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.consent_record WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_channel WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_reminder WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.appointment_booking WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.dsv_scan_signature WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.dsv_contract WHERE participation_id = p_participation_id
        AND original_location IS NOT NULL)
      OR EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
        AND retention_class = 'personnel_file' AND deleted_at IS NULL)),
    ('health_record',
      EXISTS (SELECT FROM public.participant_health_data WHERE participation_id = p_participation_id)
      OR EXISTS (SELECT FROM public.participant_profiling_health_assessment WHERE participation_id = p_participation_id)),
    ('form_working_copy', EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
      AND retention_class = 'form_working_copy' AND deleted_at IS NULL)),
    ('evidence_set', EXISTS (SELECT FROM public.document WHERE participation_id = p_participation_id
      AND retention_class = 'evidence_set' AND deleted_at IS NULL))
  ) AS v(c, present) WHERE present);
$function$;

ALTER FUNCTION public.retention_classes_left(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.retention_classes_left(uuid) FROM PUBLIC;
