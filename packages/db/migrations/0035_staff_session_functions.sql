-- Hand-written (Slice 3 plan, D1–D6; PR 3b): the staff session store, identity binding, refused
-- logins and their grants. Same hardening as 0004: SECURITY DEFINER owned by transfer_owner, a
-- fixed search_path with pg_temp last, schema-qualified names, no dynamic SQL, EXECUTE only for
-- transfer_app, refusals as P0001 with a stable code, never a value. Each function writes its
-- `staff_audit_event` in the same transaction. Times are database time.

-- A login (D1, D2): the session row under the token's SHA-256, 8 hours from now, and
-- `staff_login`. An OIDC login names the identity it authenticated, which must be the account's
-- bound one; a dev login names none. A token the browser still carried ends as `superseded`.
CREATE FUNCTION start_staff_session(
  p_staff_user_id uuid, p_token_hash text, p_method text, p_oidc_issuer text, p_oidc_subject text,
  p_superseded_token_hash text, p_request_id text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
  v_expires_at timestamptz;
BEGIN
  IF p_staff_user_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_method IS NULL OR p_method NOT IN ('oidc', 'dev')
     OR (p_method = 'oidc') <> (num_nonnulls(p_oidc_issuer, p_oidc_subject) = 2)
     OR (p_method = 'dev' AND num_nonnulls(p_oidc_issuer, p_oidc_subject) > 0) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Shared: a deactivation (which locks the row for update) never interleaves.
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF p_method = 'oidc' AND (u.oidc_issuer IS DISTINCT FROM p_oidc_issuer
      OR u.oidc_subject IS DISTINCT FROM p_oidc_subject) THEN
    RAISE EXCEPTION 'identity_mismatch';
  END IF;
  IF p_superseded_token_hash IS NOT NULL THEN
    UPDATE public.staff_session SET ended_at = now(), end_reason = 'superseded'
    WHERE token_hash = p_superseded_token_hash AND ended_at IS NULL AND expires_at > now();
  END IF;
  INSERT INTO public.staff_session (token_hash, staff_user_id, created_at, expires_at)
  VALUES (p_token_hash, u.id, now(), now() + interval '8 hours')
  RETURNING expires_at INTO v_expires_at;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_login', u.id, u.id, jsonb_build_object('method', p_method), p_request_id);
  RETURN v_expires_at;
END $$;
--> statement-breakpoint

-- A logout (D2): ends the live session of the token and writes `staff_logout`; false, and no
-- event, for a token without a live session (unknown, ended or expired).
CREATE FUNCTION end_staff_session(p_token_hash text, p_request_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_staff_user_id uuid;
BEGIN
  UPDATE public.staff_session SET ended_at = now(), end_reason = 'logout'
  WHERE token_hash = p_token_hash AND ended_at IS NULL AND expires_at > now()
  RETURNING staff_user_id INTO v_staff_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, request_id)
  VALUES ('staff_logout', v_staff_user_id, v_staff_user_id, p_request_id);
  RETURN true;
END $$;
--> statement-breakpoint

-- The first OIDC login of an active, unbound account (D5) binds `(iss, sub)` to it, once, and
-- writes `staff_identity_bound` with the claim it matched. An identity bound to another account
-- is refused as a mismatch too.
CREATE FUNCTION bind_staff_identity(
  p_staff_user_id uuid, p_oidc_issuer text, p_oidc_subject text, p_matched_by text, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  u public.staff_user;
BEGIN
  IF p_staff_user_id IS NULL OR p_matched_by IS NULL
     OR p_matched_by NOT IN ('email', 'preferred_username')
     OR p_oidc_issuer IS NULL OR p_oidc_issuer !~ '^https?://[!-~]{1,255}$'
     OR p_oidc_subject IS NULL OR p_oidc_subject !~ '^[!-~]{1,255}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO u FROM public.staff_user WHERE id = p_staff_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_account';
  END IF;
  IF u.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_deactivated';
  END IF;
  IF u.oidc_subject IS NOT NULL THEN
    RAISE EXCEPTION 'identity_mismatch';
  END IF;
  BEGIN
    UPDATE public.staff_user SET oidc_issuer = p_oidc_issuer, oidc_subject = p_oidc_subject
    WHERE id = u.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'identity_mismatch';
  END;
  INSERT INTO public.staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, details, request_id)
  VALUES ('staff_identity_bound', u.id, u.id, jsonb_build_object('matchedBy', p_matched_by), p_request_id);
END $$;
--> statement-breakpoint

-- A refused login (D5, D6): its code and the login mode, and the matched account where there is
-- one (deactivated, bound to another identity); never the claimed email, which no parameter takes.
CREATE FUNCTION record_staff_login_refused(
  p_reason_code text, p_subject_staff_user_id uuid, p_method text, p_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('oidc', 'dev')
     OR p_reason_code IS NULL
     OR p_reason_code NOT IN ('unknown_account', 'account_deactivated', 'identity_mismatch')
     OR (p_subject_staff_user_id IS NULL) <> (p_reason_code = 'unknown_account')
     OR (p_subject_staff_user_id IS NOT NULL
       AND NOT EXISTS (SELECT FROM public.staff_user WHERE id = p_subject_staff_user_id)) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  INSERT INTO public.staff_audit_event (event_type, subject_staff_user_id, reason_code, details, request_id)
  VALUES ('staff_login_refused', p_subject_staff_user_id, p_reason_code,
    jsonb_build_object('method', p_method), p_request_id);
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION start_staff_session, end_staff_session, bind_staff_identity,
  record_staff_login_refused FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION start_staff_session, end_staff_session, bind_staff_identity,
  record_staff_login_refused TO transfer_app;
--> statement-breakpoint
-- The API reads sessions (hashes only, D2); every write is a function's. No privilege on the staff
-- audit trail.
GRANT SELECT ON TABLE staff_session TO transfer_app;
