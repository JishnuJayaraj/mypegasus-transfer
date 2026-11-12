CREATE OR REPLACE FUNCTION public.mark_activation_notice_sent(p_channel_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.participant_channel SET notice_sent_at = now()
  WHERE id = p_channel_id AND notice_sent_at IS NULL;
  RETURN FOUND;
END $function$;

ALTER FUNCTION public.mark_activation_notice_sent(uuid) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.mark_activation_notice_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_activation_notice_sent(uuid) TO transfer_app;
