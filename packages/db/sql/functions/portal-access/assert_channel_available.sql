CREATE OR REPLACE FUNCTION public.assert_channel_available(p_participation_id uuid, p_kind public.contact_channel_kind, p_address text, p_replacing_own boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.contact_address_valid(p_kind, p_address) OR p_kind = 'email' AND EXISTS (
    SELECT FROM public.participant_details d
    WHERE d.participation_id = p_participation_id AND lower(d.work_email) = p_address) THEN
    RAISE EXCEPTION 'channel_invalid';
  END IF;
  IF EXISTS (SELECT FROM public.participant_channel ch
             WHERE ch.kind = p_kind AND ch.address = p_address AND ch.removed_at IS NULL
               AND NOT (p_replacing_own AND ch.participation_id = p_participation_id)) THEN
    RAISE EXCEPTION 'channel_in_use';
  END IF;
END $function$;

ALTER FUNCTION public.assert_channel_available(uuid,public.contact_channel_kind,text,boolean) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.assert_channel_available(uuid,public.contact_channel_kind,text,boolean) FROM PUBLIC;
