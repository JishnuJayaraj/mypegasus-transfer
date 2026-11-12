CREATE OR REPLACE FUNCTION public.open_sensitive_value(p_participation_id uuid, p_field text, p_ciphertext bytea, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF p_ciphertext IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v := crypto.pgp_sym_decrypt(p_ciphertext, p_key)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'decryption_failed';
  END;
  IF pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object'
     OR v ->> 'p' IS DISTINCT FROM p_participation_id::text
     OR v ->> 'f' IS DISTINCT FROM p_field OR NOT v ? 'v' THEN
    RAISE EXCEPTION 'envelope_mismatch';
  END IF;
  RETURN v -> 'v';
END $function$;

ALTER FUNCTION public.open_sensitive_value(uuid,text,bytea,text) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.open_sensitive_value(uuid,text,bytea,text) FROM PUBLIC;
