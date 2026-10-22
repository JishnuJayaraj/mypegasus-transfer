-- Hand-written (ADR-0002, documents; data-protection.md, uploads and documents; Q142–Q148): the
-- document type policy, the document functions and their grants. Same hardening as 0052:
-- SECURITY DEFINER owned by transfer_owner, a fixed search_path with pg_temp last,
-- schema-qualified names, no dynamic SQL, EXECUTE only for transfer_app, database time, refusals
-- as P0001 with a stable code, never a value. Audit entries carry ids and codes only: never a file
-- name, the content or its hash.
--
-- Who acts: the participant through their live active session of the participation, staff in
-- normal mode by their project roles (the consultant while assigned), staff in assisted mode
-- through the live mode of their session (`lock_assisted_mode`). The roles are matched against
-- the type's policy row, which a drift test holds equal to the domain's catalog.

ALTER TABLE audit_event DROP CONSTRAINT audit_event_lifecycle_has_participation;
--> statement-breakpoint
ALTER TABLE audit_event ADD CONSTRAINT audit_event_lifecycle_has_participation CHECK (
  participation_id IS NOT NULL OR event_type::text NOT IN (
    'participation_created', 'status_changed', 'entry_wave_assigned',
    'profiling_exception_requested', 'profiling_exception_approved',
    'profiling_exception_rejected', 'profiling_exception_revoked',
    'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed',
    'participation_created_manually', 'participation_dates_changed', 'sensitive_read',
    'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned',
    'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
    'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
    'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
    'one_time_code_exhausted', 'participant_logout', 'participant_login',
    'contact_channel_removed', 'consent_ended', 'contact_channels_suspended', 'placement_agentur_set',
    'self_service_notice_acknowledged', 'step_up_completed', 'step_up_failed',
    'assisted_mode_started', 'assisted_mode_ended', 'document_added', 'document_reviewed',
    'document_deleted', 'document_upload_rejected'));
--> statement-breakpoint

-- Catalog version 2 (packages/domain/src/documents/catalog.ts): the open roles are those with the
-- right `open`; opening in assisted mode or through break-glass comes with the types' slices.
INSERT INTO document_type_policy (type, catalog_version, retention_class, file_name, signed,
  add_roles, review_roles, delete_roles, open_roles) VALUES
  ('tl407_signed_scan', 2, 'evidence_set', false, true, '{}', '{}', '{}',
    '{consultant,project_lead}'),
  ('kug200b_signed_scan', 2, 'evidence_set', false, true, '{}', '{}', '{}',
    '{consultant,project_lead}'),
  ('dsv_signed_scan', 2, 'personnel_file', false, true, '{}', '{}', '{}',
    '{project_lead,back_office}'),
  ('dsv_cancellation', 2, 'personnel_file', false, true, '{}', '{}', '{}',
    '{project_lead,back_office}'),
  ('asu_proof', 2, 'participation_record', false, false, '{}', '{}', '{}', '{consultant}'),
  ('profiling_exception_evidence', 2, 'participation_record', false, false, '{}', '{}', '{}',
    '{consultant}'),
  ('cv', 2, 'personnel_file', true, false, '{participant,consultant,project_lead}',
    '{consultant,project_lead}', '{participant,consultant,project_lead}',
    '{participant,consultant,project_lead}'),
  ('participant_upload', 2, 'personnel_file', true, false, '{participant,consultant,project_lead}',
    '{consultant,project_lead}', '{participant,consultant,project_lead}',
    '{participant,consultant,project_lead}'),
  ('qualification_certificate', 2, 'personnel_file', true, false,
    '{participant,consultant,project_lead}', '{consultant,project_lead}',
    '{participant,consultant,project_lead}', '{participant,consultant,project_lead}');
--> statement-breakpoint

-- Internal helpers (no grant).

-- The project roles of an active staff user in the participation's project; the consultant only
-- while assigned to it (Q62).
CREATE FUNCTION document_staff_roles(p_participation_id uuid, p_staff_user_id uuid)
RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(
    SELECT DISTINCT m.role::text
    FROM public.participation p
    JOIN public.project_membership m
      ON m.project_id = p.project_id AND m.staff_user_id = p_staff_user_id
    JOIN public.staff_user u ON u.id = m.staff_user_id AND u.deactivated_at IS NULL
    WHERE p.id = p_participation_id
      AND (m.role <> 'consultant' OR EXISTS (
        SELECT FROM public.participant_assignment a
        WHERE a.participation_id = p.id AND a.staff_user_id = m.staff_user_id
          AND a.ended_at IS NULL))
    ORDER BY 1)
$$;
--> statement-breakpoint

-- The policy a new document of the type gets: the type's row of the latest catalog version.
CREATE FUNCTION current_document_policy(p_type document_type)
RETURNS document_type_policy LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM public.document_type_policy WHERE type = p_type
  ORDER BY catalog_version DESC LIMIT 1
$$;
--> statement-breakpoint

-- The actor of a document call on a participation, with the participation locked first: a
-- participant through their live active session of it (`session_invalid`, which an `activating`
-- session is too), staff in assisted mode through the live mode of the session (`p_token_hash` is
-- then the staff session's hash), staff in normal mode by their project roles. With `p_open`, a
-- terminal participation is refused first (`participation_closed`). Returns the roles to match
-- against the policy: `{participant}`, or the staff user's.
CREATE FUNCTION lock_document_actor(
  p_participation_id uuid, p_context audit_context, p_token_hash text, p_open boolean
) RETURNS text[] LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.participation; s public.participant_session;
BEGIN
  PERFORM public.assert_context(p_context, p_participation_id, '{participant,user}');
  IF NOT EXISTS (SELECT FROM public.participation WHERE id = p_participation_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  r := public.lock_participation(p_participation_id);
  IF p_open AND r.status IN ('withdrawn', 'ta_completed', 'exited') THEN
    RAISE EXCEPTION 'participation_closed';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    s := public.lock_active_session(p_token_hash);
    IF s.participation_id <> p_participation_id THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
    RETURN '{participant}';
  END IF;
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RETURN public.lock_assisted_mode(p_participation_id, p_context, p_token_hash);
  END IF;
  RETURN public.document_staff_roles(p_participation_id, (p_context).staff_user_id);
END $$;
--> statement-breakpoint

-- The functions transfer_app may execute.

-- An upload stored (data-protection.md, uploads; Q143, Q146): the API detected the type, scanned,
-- encrypted and stored the object first, and deletes it on any refusal here. Under the
-- participation lock: `participation_closed`, `document_type_not_supported` (operations
-- undecided, Q65), `actor_not_allowed` (not an add role of the type, or a file name for a type
-- that keeps none: `invalid_argument`), `document_limit` (50 live documents) and
-- `upload_rate_limited` (20 added within the hour, by anyone; documentLimits). Audited
-- `document_added` (id, type, source `portal` / `staff` / `assisted`). Returns the id.
CREATE FUNCTION add_document(
  p_context audit_context, p_participation_id uuid, p_id uuid, p_type document_type,
  p_media_type document_media_type, p_size_bytes integer, p_content_sha256 text,
  p_file_name text, p_key_id text, p_wrapped_key bytea, p_token_hash text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pol public.document_type_policy := public.current_document_policy(p_type);
  v_roles text[];
  v_project_id uuid;
BEGIN
  IF p_id IS NULL OR p_type IS NULL OR p_media_type IS NULL OR p_size_bytes IS NULL
     OR p_size_bytes NOT BETWEEN 1 AND 10485760
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{16}$'
     OR p_wrapped_key IS NULL OR pg_catalog.octet_length(p_wrapped_key) <> 60
     OR p_file_name IS NOT NULL AND (pg_catalog.char_length(p_file_name) NOT BETWEEN 1 AND 200
       OR p_file_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(p_participation_id, p_context, p_token_hash, true);
  IF pg_catalog.cardinality(pol.add_roles) = 0 THEN
    RAISE EXCEPTION 'document_type_not_supported';
  END IF;
  IF NOT v_roles && pol.add_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF p_file_name IS NOT NULL AND NOT pol.file_name THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE participation_id = p_participation_id AND deleted_at IS NULL) >= 50 THEN
    RAISE EXCEPTION 'document_limit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.document
      WHERE participation_id = p_participation_id AND added_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'upload_rate_limited';
  END IF;
  SELECT project_id INTO v_project_id FROM public.participation WHERE id = p_participation_id;
  INSERT INTO public.document (id, project_id, participation_id, type, catalog_version,
    retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key,
    added_by, added_by_staff_user_id, added_on_behalf)
  VALUES (p_id, v_project_id, p_participation_id, p_type, pol.catalog_version,
    pol.retention_class, p_media_type, p_size_bytes, p_content_sha256, p_file_name, p_key_id,
    p_wrapped_key, (p_context).actor_type, (p_context).staff_user_id,
    (p_context).on_behalf_of IS NOT NULL);
  PERFORM public.write_audit_event(v_project_id, p_participation_id, 'document_added', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_build_object('documentId', p_id,
      'documentType', p_type, 'source', CASE
        WHEN (p_context).actor_type = 'participant' THEN 'portal'
        WHEN (p_context).on_behalf_of IS NOT NULL THEN 'assisted'
        ELSE 'staff' END), false);
  RETURN p_id;
END $$;
--> statement-breakpoint

-- An upload the scan refused (Q144): nothing was stored; only the audit event
-- `document_upload_rejected` with the type and the code (`file_infected`, `file_unscannable`),
-- after the same actor checks as `add_document`.
CREATE FUNCTION record_document_upload_rejected(
  p_context audit_context, p_participation_id uuid, p_type document_type, p_code text,
  p_token_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pol public.document_type_policy := public.current_document_policy(p_type);
  v_roles text[];
BEGIN
  IF p_type IS NULL OR p_code IS NULL OR p_code NOT IN ('file_infected', 'file_unscannable') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(p_participation_id, p_context, p_token_hash, true);
  IF pg_catalog.cardinality(pol.add_roles) = 0 THEN
    RAISE EXCEPTION 'document_type_not_supported';
  END IF;
  IF NOT v_roles && pol.add_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM public.write_audit_event(
    (SELECT project_id FROM public.participation WHERE id = p_participation_id),
    p_participation_id, 'document_upload_rejected', p_context, NULL, NULL, NULL, p_code, NULL,
    pg_catalog.jsonb_build_object('documentType', p_type), false);
END $$;
--> statement-breakpoint

-- Opening a live document (Q147): the open right again (the participant their own; staff by the
-- policy's open roles, the consultant while assigned; in assisted mode through the live mode), and
-- a session of the caller (`p_session_kind`, `p_session_hash`: the participant's portal session,
-- or the staff session, which must be the context's staff user's and live). Inserts the link
-- (only its token's SHA-256), bound to that session and valid 60 s, and audits
-- `document_opened`. Returns when the link expires.
CREATE FUNCTION open_document(
  p_context audit_context, p_document_id uuid, p_session_kind document_session_kind,
  p_session_hash text, p_link_hash text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_roles text[];
  v_expires timestamptz := now() + interval '60 seconds';
BEGIN
  IF p_document_id IS NULL OR p_session_kind IS NULL
     OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT * INTO d FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, d.participation_id, '{participant,user}');
  IF ((p_context).actor_type = 'participant') <> (p_session_kind = 'participant') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF (p_context).actor_type = 'user' AND (p_context).on_behalf_of IS NULL THEN
    PERFORM FROM public.staff_session s
    JOIN public.staff_user u ON u.id = s.staff_user_id
    WHERE s.token_hash = p_session_hash AND s.staff_user_id = (p_context).staff_user_id
      AND s.ended_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'session_invalid';
    END IF;
  END IF;
  v_roles := public.lock_document_actor(d.participation_id, p_context, p_session_hash, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.open_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  INSERT INTO public.document_link (token_hash, document_id, project_id, participation_id,
    session_kind, session_hash, expires_at)
  VALUES (p_link_hash, d.id, d.project_id, d.participation_id, p_session_kind, p_session_hash,
    v_expires);
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_opened', p_context,
    NULL, NULL, NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('documentType', d.type, 'documentId', d.id), false);
  RETURN v_expires;
END $$;
--> statement-breakpoint

-- What the content route needs to answer a link (Q147): only a live link (not expired) of this
-- session kind and hash, the session still live (a participant's active one; a staff one not
-- ended or expired, of an active account), and a live document. Not audited again: the opening
-- was. The only path that returns the wrapped key.
CREATE FUNCTION document_link_content(
  p_link_hash text, p_session_kind document_session_kind, p_session_hash text
) RETURNS TABLE (
  document_id uuid, participation_id uuid, document_type document_type,
  media_type document_media_type, file_name text, key_id text, wrapped_key bytea,
  added_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT d.id, d.participation_id, d.type, d.media_type, d.file_name, d.key_id, d.wrapped_key,
    d.added_at
  FROM public.document_link l
  JOIN public.document d ON d.id = l.document_id
  WHERE l.token_hash = p_link_hash AND l.session_kind = p_session_kind
    AND l.session_hash = p_session_hash AND l.expires_at > now() AND d.deleted_at IS NULL
    AND CASE p_session_kind
      WHEN 'participant' THEN EXISTS (
        SELECT FROM public.participant_session s
        WHERE s.token_hash = p_session_hash AND s.state = 'active'
          AND public.participant_session_live(s))
      ELSE EXISTS (
        SELECT FROM public.staff_session s
        JOIN public.staff_user u ON u.id = s.staff_user_id
        WHERE s.token_hash = p_session_hash AND s.ended_at IS NULL AND s.expires_at > now()
          AND u.deactivated_at IS NULL)
    END
$$;
--> statement-breakpoint

-- A review (process-and-lifecycle.md, document review; Q146): staff in normal mode by the
-- policy's review roles, once and final (`document_reviewed` for a second one); `accepted`, or
-- `rejected` with a reason code. Audited `document_reviewed` (the decision; the reason as its
-- reason code).
CREATE FUNCTION review_document(
  p_context audit_context, p_document_id uuid, p_decision document_review_state,
  p_reason document_review_reason
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL OR p_decision IS NULL OR p_decision = 'unreviewed'
     OR (p_decision = 'rejected') <> (p_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, NULL, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF NOT v_roles && pol.review_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF d.review_state <> 'unreviewed' THEN
    RAISE EXCEPTION 'document_reviewed';
  END IF;
  UPDATE public.document SET review_state = p_decision, review_reason = p_reason,
    reviewed_by = (p_context).staff_user_id, reviewed_at = now()
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_reviewed',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type,
      'decision', p_decision), false);
END $$;
--> statement-breakpoint

-- A deletion (Q146): staff in normal mode by the policy's delete roles, with a reason code; the
-- participant their own (`actor_not_allowed` for one staff added) while not accepted
-- (`document_accepted`), without one. Signed types never (`document_immutable`; the retention job
-- only). The row stays as a tombstone, its file name erased; the API queues the object's purge in
-- the same transaction. Audited `document_deleted` (the reason as its reason code).
CREATE FUNCTION delete_document(
  p_context audit_context, p_document_id uuid, p_reason document_delete_reason,
  p_token_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.document;
  pol public.document_type_policy;
  v_participation_id uuid;
  v_roles text[];
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  SELECT participation_id INTO v_participation_id FROM public.document WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  PERFORM public.assert_context(p_context, v_participation_id, '{participant,user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF ((p_context).actor_type = 'user') <> (p_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  v_roles := public.lock_document_actor(v_participation_id, p_context, p_token_hash, false);
  SELECT * INTO d FROM public.document WHERE id = p_document_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;
  SELECT * INTO pol FROM public.document_type_policy
  WHERE type = d.type AND catalog_version = d.catalog_version;
  IF pol.signed THEN
    RAISE EXCEPTION 'document_immutable';
  END IF;
  IF NOT v_roles && pol.delete_roles THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF (p_context).actor_type = 'participant' THEN
    IF d.added_by <> 'participant' THEN
      RAISE EXCEPTION 'actor_not_allowed';
    END IF;
    IF d.review_state = 'accepted' THEN
      RAISE EXCEPTION 'document_accepted';
    END IF;
  END IF;
  UPDATE public.document SET deleted_at = now(), deleted_by = (p_context).actor_type,
    deleted_by_staff_user_id = (p_context).staff_user_id, delete_reason = p_reason,
    file_name = NULL
  WHERE id = d.id;
  PERFORM public.write_audit_event(d.project_id, d.participation_id, 'document_deleted',
    p_context, NULL, NULL, NULL, p_reason::text, NULL,
    pg_catalog.jsonb_build_object('documentId', d.id, 'documentType', d.type), false);
END $$;
--> statement-breakpoint

-- The purge job (`documents.purge-object`, ADR-0011) deleted a deleted document's object: records
-- `purged_at` once (a retry returns false). A live or unknown document is refused
-- (`document_not_deleted`): its object is never purged.
CREATE FUNCTION record_document_purged(p_document_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM public.document WHERE id = p_document_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'document_not_deleted';
  END IF;
  UPDATE public.document SET purged_at = now() WHERE id = p_document_id AND purged_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- Replaced: the document events are written only by their functions too.
CREATE OR REPLACE FUNCTION record_audit_event(
  p_project_id uuid, p_participation_id uuid, p_event_type audit_event_type, p_context audit_context,
  p_reason_code text DEFAULT NULL, p_effective_date date DEFAULT NULL, p_details jsonb DEFAULT '{}',
  p_flagged_for_review boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_event_type::text IN ('participation_created', 'status_changed', 'entry_wave_assigned',
      'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected',
      'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected',
      'project_created', 'project_changed', 'entry_wave_created', 'entry_wave_changed',
      'config_template_pinned', 'config_override_changed', 'rule_relaxation_requested',
      'rule_relaxation_approved', 'rule_relaxation_rejected', 'rule_relaxation_withdrawn',
      'project_activated', 'participant_data_changed', 'participation_dates_changed',
      'project_member_added', 'project_member_removed', 'participant_assigned',
      'participant_unassigned', 'activation_code_issued', 'activation_code_delivery',
      'activation_code_handed_over', 'activation_code_revoked', 'privacy_notice_provided',
      'participant_activated', 'consent_given', 'contact_channel_added', 'activation_code_locked',
      'one_time_code_exhausted', 'participant_logout', 'participant_login',
      'contact_channel_removed', 'consent_ended', 'contact_channels_suspended',
      'placement_agentur_set', 'self_service_notice_acknowledged', 'step_up_completed',
      'step_up_failed', 'assisted_mode_started', 'assisted_mode_ended', 'document_opened',
      'document_added', 'document_reviewed', 'document_deleted', 'document_upload_rejected') THEN
    RAISE EXCEPTION 'event_type_reserved';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user,participant,system}');
  IF NOT EXISTS (SELECT FROM public.project WHERE id = p_project_id) THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p_participation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.participation WHERE id = p_participation_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'participation_not_found';
  END IF;
  RETURN public.write_audit_event(p_project_id, p_participation_id, p_event_type, p_context,
    NULL, NULL, NULL, p_reason_code, p_effective_date, p_details,
    coalesce(p_flagged_for_review, false));
END $$;
--> statement-breakpoint

-- Grants: transfer_app selects the policy and every document column but the wrapped key and the
-- content hash (column grants); it has no privilege on document_link and writes neither table.
GRANT SELECT ON TABLE document_type_policy TO transfer_app;
--> statement-breakpoint
GRANT SELECT (id, project_id, participation_id, type, catalog_version, retention_class, media_type,
  size_bytes, file_name, key_id, added_by, added_by_staff_user_id, added_on_behalf, added_at,
  review_state, review_reason, reviewed_by, reviewed_at, deleted_at, deleted_by,
  deleted_by_staff_user_id, delete_reason, purged_at) ON TABLE document TO transfer_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION document_staff_roles, current_document_policy, lock_document_actor,
  add_document, record_document_upload_rejected, open_document, document_link_content,
  review_document, delete_document, record_document_purged FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_document, record_document_upload_rejected, open_document,
  document_link_content, review_document, delete_document, record_document_purged TO transfer_app;
