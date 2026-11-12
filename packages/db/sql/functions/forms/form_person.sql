CREATE OR REPLACE FUNCTION public.form_person(p_participation_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'firstName', coalesce(i.first_name, ''), 'lastName', coalesce(i.last_name, ''),
    'birthDate', i.birth_date::text,
    'street', d.address_street,
    'postalCode', CASE WHEN d.address_street IS NOT NULL THEN d.address_postal_code END,
    'city', CASE WHEN d.address_street IS NOT NULL THEN d.address_city END,
    'country', CASE WHEN d.address_street IS NOT NULL THEN d.address_country END,
    'phone', d.phone, 'mobile', d.mobile, 'privateEmail', d.private_email,
    'tgStart', coalesce(p.tg_start, w.default_tg_start)::text,
    'tgEnd', coalesce(p.tg_end, w.default_tg_end)::text)
  FROM public.participation p
  LEFT JOIN public.participant_identity i ON i.participation_id = p.id
  LEFT JOIN public.participant_details d ON d.participation_id = p.id
  LEFT JOIN public.project_entry_wave w ON w.id = p.entry_wave_id
  WHERE p.id = p_participation_id
$function$;

ALTER FUNCTION public.form_person(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.form_person(uuid) FROM PUBLIC;
