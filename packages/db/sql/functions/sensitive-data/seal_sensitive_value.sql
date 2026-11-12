CREATE OR REPLACE FUNCTION public.seal_sensitive_value(p_participation_id uuid, p_field text, p_value jsonb, p_key text)
 RETURNS bytea
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_value IS NULL OR p_value = 'null'::jsonb THEN NULL
    ELSE crypto.pgp_sym_encrypt(pg_catalog.jsonb_build_object('p', p_participation_id,
      'f', p_field, 'v', p_value)::text, p_key, 'cipher-algo=aes256, compress-algo=0') END
$function$;

ALTER FUNCTION public.seal_sensitive_value(uuid,text,jsonb,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.seal_sensitive_value(uuid,text,jsonb,text) FROM PUBLIC;
