-- Hand-written (ADR-0002; data-protection.md, evidence corrections: field targets and the DSV
-- signature-date supersession; process-and-lifecycle.md, the profiling track and the DSV
-- signature): date corrections. The PL requests a correction of `profilingDoneOn` or of a manual
-- `withdrawnOn`; the PL or back office requests the supersession of one signature date on accepted
-- DSV paper; the regional operations manager of the project's region decides (four eyes). Same
-- hardening as 0088: SECURITY DEFINER owned by transfer_owner, a fixed search_path with pg_temp
-- last, schema-qualified names, no dynamic SQL, database time, refusals as P0001 with a stable
-- code, never a value. The enum values 0105 added are compared as text.
--
-- Lock order (ADR-0002): a request takes the project's shared lock and the participation row
-- (`lock_participation`), then the DSV paper's document rows (id order) and the offer; a decision
-- the project's exclusive lock, the participation row, the document rows, the offer, the contract,
-- then the correction row.
--
-- The upgrade of an existing database: every signature row stays current (`superseded_by` null),
-- every existing correction keeps its target (the new columns null), so 0105's checks hold.

-- A superseded signature row stays beside its replacement: one current row per scan and kind.
DROP INDEX public.dsv_signature_once;
--> statement-breakpoint
CREATE UNIQUE INDEX dsv_signature_once ON public.dsv_scan_signature(document_id, kind)
  WHERE superseded_by IS NULL;
--> statement-breakpoint
ALTER TABLE public.dsv_scan_signature ADD CONSTRAINT dsv_signature_correction
  CHECK (superseded_by IS NULL OR correction_id IS NULL OR superseded_by <> correction_id);
--> statement-breakpoint

-- The domain's `auditProjection` (the drift test holds them equal): a field correction's field key,
-- a signature supersession's paper and signature kind; never a value or a date.
UPDATE audit_event_projection
SET detail_keys = '{targetKind,action,reason,fieldKey,paper,signatureKind}'
WHERE event_type = 'evidence_correction_requested';
--> statement-breakpoint
UPDATE audit_event_projection
SET detail_keys = '{targetKind,action,reason,fieldKey,paper,signatureKind,decision}'
WHERE event_type = 'evidence_correction_decided';
--> statement-breakpoint

-- Append-only (0088), with the new target columns immutable too.
CREATE OR REPLACE FUNCTION evidence_correction_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status::text <> 'requested' OR NEW.status::text = 'requested'
     OR (NEW.id, NEW.project_id, NEW.participation_id, NEW.target_kind, NEW.action,
         NEW.document_id, NEW.asu_registration_id, NEW.ba_reporting_task_id, NEW.wrong_person,
         NEW.corrected_registered_on, NEW.field_key, NEW.dsv_offer_id, NEW.signature_paper,
         NEW.signature_kind, NEW.corrected_on, NEW.original_on, NEW.reason, NEW.source,
         NEW.retention_class, NEW.requested_by, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.project_id, OLD.participation_id, OLD.target_kind, OLD.action,
         OLD.document_id, OLD.asu_registration_id, OLD.ba_reporting_task_id, OLD.wrong_person,
         OLD.corrected_registered_on, OLD.field_key, OLD.dsv_offer_id, OLD.signature_paper,
         OLD.signature_kind, OLD.corrected_on, OLD.original_on, OLD.reason, OLD.source,
         OLD.retention_class, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'correction_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- As 0096, reading the current signature rows only, and only the contract's own scans (a
-- cancellation's participant date is another paper's).
CREATE OR REPLACE FUNCTION public.assert_dsv_participant_date(p_offer_id uuid, p_participant text, p_exclude uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_participant IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT FROM public.document d
      JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
        AND s.superseded_by IS NULL
      WHERE d.dsv_offer_id = p_offer_id AND d.type = 'dsv_signed_scan'
        AND d.review_state = 'accepted' AND d.deleted_at IS NULL
        AND d.id IS DISTINCT FROM p_exclude AND s.signed_on <> p_participant::date) THEN
    RAISE EXCEPTION 'signature_date_mismatch';
  END IF;
END $$;
--> statement-breakpoint

-- As 0096, reading the current signature rows (process-and-lifecycle.md, the DSV signature-date
-- supersession): a superseded date no longer counts; its replacement carries the corrected actual
-- date and records at the approval, so `recorded_at` (the latest of the acceptance, a lift and the
-- signatures' recording) is never before the approval for a corrected fact.
CREATE OR REPLACE FUNCTION public.dsv_facts(p_ids uuid[])
RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, signed_on date,
  recorded_at timestamptz, customer_signed_on date, tg_signed_on date, executed_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT d.participation_id, d.id, o.id, s.signed_on,
 greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at),
 c.signed_on, t.signed_on,
 CASE WHEN o.ended_as = 'signed' AND c.signed_on IS NOT NULL AND t.signed_on IS NOT NULL
   AND s.signed_on = (SELECT pg_catalog.min(x.signed_on) FROM public.dsv_scan_signature x
     JOIN public.document y ON y.id = x.document_id
     WHERE y.dsv_offer_id = o.id AND y.type = 'dsv_signed_scan' AND y.review_state = 'accepted'
       AND y.deleted_at IS NULL AND x.kind = 'participant' AND x.superseded_by IS NULL)
 THEN greatest(s.signed_on, c.signed_on, t.signed_on) END
 FROM public.document d JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
   AND s.superseded_by IS NULL
 LEFT JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
   AND c.superseded_by IS NULL
 LEFT JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
   AND t.superseded_by IS NULL
 WHERE d.participation_id = ANY(p_ids) AND (o.ended_as IS NULL OR o.ended_as = 'signed')
 AND d.type = 'dsv_signed_scan' AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL AND d.dsv_received_on >= s.signed_on
$$;
--> statement-breakpoint

-- As 0102, reading the current signature rows.
CREATE OR REPLACE FUNCTION public.dsv_cancellation_facts(p_ids uuid[])
RETURNS TABLE(participation_id uuid, document_id uuid, offer_id uuid, valid_on date,
  recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT d.participation_id, d.id, o.id, greatest(s.signed_on, c.signed_on, t.signed_on),
   greatest(d.reviewed_at, d.quarantine_lifted_at, s.recorded_at, c.recorded_at, t.recorded_at)
 FROM public.document d
 JOIN public.dsv_offer o ON o.id = d.dsv_offer_id AND o.participation_id = d.participation_id
   AND o.ended_as = 'signed'
 JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = 'participant'
   AND s.superseded_by IS NULL
 JOIN public.dsv_scan_signature c ON c.document_id = d.id AND c.kind = 'customer'
   AND c.superseded_by IS NULL
 JOIN public.dsv_scan_signature t ON t.document_id = d.id AND t.kind = 'transfergesellschaft'
   AND t.superseded_by IS NULL
 WHERE d.participation_id = ANY(p_ids) AND d.type = 'dsv_cancellation'
 AND d.review_state = 'accepted' AND d.deleted_at IS NULL
 AND d.quarantined_at IS NULL AND d.invalidated_by_correction IS NULL
 AND d.dsv_received_by IS NOT NULL
$$;
--> statement-breakpoint

-- As 0072, with a corrected completion recorded at its approval (process-and-lifecycle.md, the
-- profiling track: a corrected `profilingDoneOn`): `profilingDone` is valid on the column's date
-- (the corrected one once approved) and recorded at the latest of the supporting scan's
-- availability, the status change and the latest approved correction of `profilingDoneOn`. So a
-- scheduled run before the approval never counts the corrected date; a later run or a
-- reconciliation does.
CREATE OR REPLACE FUNCTION tl407_facts(p_participation_ids uuid[])
RETURNS TABLE (
  participation_id uuid, tl407_signed_on date, tl407_recorded_at timestamptz,
  profiling_done_on date, profiling_done_recorded_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH evidence AS (
    SELECT d.participation_id, greatest(d.signed_on, d.countersigned_on) AS valid_on,
      greatest(d.reviewed_at, coalesce(d.quarantine_lifted_at, d.reviewed_at)) AS recorded_at
    FROM public.document d
    WHERE d.participation_id = ANY (p_participation_ids) AND d.type = 'tl407_signed_scan'
      AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
      AND d.invalidated_by_correction IS NULL
  ), scan AS (
    SELECT DISTINCT ON (e.participation_id) e.participation_id, e.valid_on, e.recorded_at
    FROM evidence e
    ORDER BY e.participation_id, e.valid_on, e.recorded_at
  ), support AS (
    -- The scans that support the recorded completion date: signed by it.
    SELECT e.participation_id, pg_catalog.min(e.recorded_at) AS recorded_at
    FROM evidence e
    JOIN public.participation p ON p.id = e.participation_id
    WHERE e.valid_on <= p.profiling_done_on
    GROUP BY e.participation_id
  )
  SELECT s.participation_id, s.valid_on, s.recorded_at,
    CASE WHEN u.recorded_at IS NOT NULL THEN p.profiling_done_on END,
    CASE WHEN u.recorded_at IS NOT NULL THEN greatest(u.recorded_at, (
      SELECT pg_catalog.max(a.occurred_at) FROM public.audit_event a
      WHERE a.participation_id = p.id AND a.event_type = 'status_changed'
        AND a.field = 'profiling_status' AND a.to_value = 'profiling_done'), (
      SELECT pg_catalog.max(c.decided_at) FROM public.evidence_correction c
      WHERE c.participation_id = p.id AND c.target_kind::text = 'field'
        AND c.field_key = 'profilingDoneOn' AND c.status::text = 'approved')) END
  FROM scan s
  JOIN public.participation p ON p.id = s.participation_id
  LEFT JOIN support u ON u.participation_id = s.participation_id
$$;
--> statement-breakpoint

-- The status change that recorded a correctable field (the participation's latest change to
-- `profiling_done` for `profilingDoneOn`, to `withdrawn` for `withdrawnOn`): who made it (the actor
-- type) and when. The views read it ("Korrektur beantragen" only for a manual withdrawal; the
-- target's recording day in "Freigaben"); transfer_app reads no audit event itself.
CREATE FUNCTION field_status_change(p_participation_id uuid, p_field_key text)
RETURNS TABLE (actor_type text, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.actor_type::text, a.occurred_at FROM public.audit_event a
  WHERE a.participation_id = p_participation_id AND a.event_type = 'status_changed'
    AND (p_field_key, a.field::text, a.to_value) IN (('profilingDoneOn', 'profiling_status',
      'profiling_done'), ('withdrawnOn', 'status', 'withdrawn'))
  ORDER BY a.occurred_at DESC, a.seq DESC LIMIT 1
$$;
--> statement-breakpoint

-- What a field correction is checked against (data-protection.md, evidence corrections: field
-- targets): the recorded value (null while the field holds none), and the rule's refusal for the
-- corrected date, or null. `profilingDoneOn`: the profiling track `profiling_done`; not in the
-- future; not before the earliest later signature date of a usable accepted TL 407 (Q191).
-- `withdrawnOn`: the participation `withdrawn` by a user (a system withdrawal's date is derived:
-- `withdrawal_by_system`); not in the future; for a signed DSV (the cancellation-based withdrawal)
-- not before a counting cancellation's validity. Internal; the caller holds the participation.
CREATE FUNCTION field_correction_problem(r public.participation, p_field_key text,
  p_corrected_on date, OUT original date, OUT problem text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor text;
  v_bound date;
BEGIN
  IF p_field_key = 'profilingDoneOn' THEN
    original := CASE WHEN r.profiling_status::text = 'profiling_done' THEN r.profiling_done_on END;
  ELSE
    original := CASE WHEN r.status::text = 'withdrawn' THEN r.withdrawn_on END;
  END IF;
  IF original IS NULL THEN
    problem := 'field_not_recorded';
    RETURN;
  END IF;
  IF p_field_key = 'withdrawnOn' THEN
    SELECT f.actor_type INTO v_actor FROM public.field_status_change(r.id, 'withdrawnOn') f;
    IF v_actor IS DISTINCT FROM 'user' THEN
      problem := 'withdrawal_by_system';
      RETURN;
    END IF;
  END IF;
  IF p_corrected_on = original THEN
    problem := 'correction_unchanged';
  ELSIF p_corrected_on > public.berlin_today() THEN
    problem := 'corrected_on_in_future';
  ELSIF p_field_key = 'profilingDoneOn' THEN
    SELECT pg_catalog.min(greatest(d.signed_on, d.countersigned_on)) INTO v_bound
    FROM public.document d
    WHERE d.participation_id = r.id AND d.type = 'tl407_signed_scan'
      AND d.review_state = 'accepted' AND d.deleted_at IS NULL AND d.quarantined_at IS NULL
      AND d.invalidated_by_correction IS NULL;
    IF v_bound IS NULL OR p_corrected_on < v_bound THEN
      problem := 'effective_date_before_signature';
    END IF;
  ELSIF r.dsv_status::text = 'dsv_signed' THEN
    SELECT pg_catalog.min(f.valid_on) INTO v_bound
    FROM public.dsv_cancellation_facts(ARRAY[r.id]) f;
    IF v_bound IS NULL OR p_corrected_on < v_bound THEN
      problem := 'effective_date_before_cancellation';
    END IF;
  END IF;
END $$;
--> statement-breakpoint

-- What a signature supersession is checked against (process-and-lifecycle.md, the DSV
-- signature-date supersession): the current rows of the signature on the paper's accepted scans
-- of the offer (live, not invalidated; quarantined ones too, so a lift shows the corrected date),
-- which must agree on one date (the original); the corrected date differs, isn't in the future and
-- keeps the paper's order (received not before the participant's signature). Internal.
CREATE FUNCTION signature_correction_problem(p_offer_id uuid, p_paper text, p_kind text,
  p_corrected_on date, OUT original date, OUT problem text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_dates integer;
BEGIN
  SELECT pg_catalog.min(s.signed_on), pg_catalog.count(DISTINCT s.signed_on)
  INTO original, v_dates
  FROM public.document d
  JOIN public.dsv_scan_signature s ON s.document_id = d.id AND s.kind = p_kind
    AND s.superseded_by IS NULL
  WHERE d.dsv_offer_id = p_offer_id AND d.type::text = p_paper AND d.review_state = 'accepted'
    AND d.deleted_at IS NULL AND d.invalidated_by_correction IS NULL;
  IF original IS NULL THEN
    problem := 'signature_not_shown';
  ELSIF v_dates > 1 THEN
    problem := 'signature_date_mismatch';
  ELSIF p_corrected_on = original THEN
    problem := 'correction_unchanged';
  ELSIF p_corrected_on > public.berlin_today() THEN
    problem := 'corrected_on_in_future';
  ELSIF p_kind = 'participant' AND EXISTS (
      SELECT FROM public.document d
      WHERE d.dsv_offer_id = p_offer_id AND d.type::text = p_paper
        AND d.review_state = 'accepted' AND d.deleted_at IS NULL
        AND d.invalidated_by_correction IS NULL AND d.dsv_received_on < p_corrected_on) THEN
    problem := 'received_before_signature';
  END IF;
END $$;
--> statement-breakpoint

-- The request (0088), with two more targets (data-protection.md, evidence corrections):
-- - `field` / `supersede` (`p_target_id` null): `p_field_key` `profilingDoneOn` or `withdrawnOn`
--   with the corrected date (`p_corrected_on`), by the PL; any other field is `invalid_argument`
--   (and 0105's check); the rules of `field_correction_problem`;
-- - `dsv_signature` / `supersede` (`p_target_id` the offer, `target_not_found` for another
--   participation's): the paper (`dsv_signed_scan` or `dsv_cancellation`), the signature kind and
--   the corrected date, by the PL or back office (the scan's readers); the rules of
--   `signature_correction_problem`.
-- The original date is stored beside the corrected one. One pending request per field or per
-- offer, paper and signature (`correction_pending`). Audited with the field key, or the paper and
-- the signature kind; never a date. Everything else as 0088.
DROP FUNCTION request_evidence_correction(audit_context, uuid, correction_target_kind,
  correction_action, uuid, boolean, date, correction_reason, text);
--> statement-breakpoint
CREATE FUNCTION request_evidence_correction(
  p_context audit_context, p_participation_id uuid, p_target_kind correction_target_kind,
  p_action correction_action, p_target_id uuid, p_wrong_person boolean,
  p_corrected_registered_on date, p_reason correction_reason, p_source text,
  p_field_key text DEFAULT NULL, p_corrected_on date DEFAULT NULL,
  p_signature_paper text DEFAULT NULL, p_signature_kind text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_date_target boolean := p_target_kind::text IN ('field', 'dsv_signature');
  v_shape_ok boolean := CASE p_target_kind::text
    WHEN 'document' THEN p_action::text = 'invalidate' AND p_wrong_person IS NOT NULL
      AND p_corrected_registered_on IS NULL
    WHEN 'asu_registration' THEN p_wrong_person IS NULL
      AND (p_action::text = 'supersede') = (p_corrected_registered_on IS NOT NULL)
    WHEN 'ba_reporting_task' THEN p_action::text = 'supersede' AND p_wrong_person IS NULL
      AND p_corrected_registered_on IS NULL
    WHEN 'field' THEN p_action::text = 'supersede' AND p_target_id IS NULL
      AND p_wrong_person IS NULL AND p_corrected_registered_on IS NULL
      AND p_field_key IN ('profilingDoneOn', 'withdrawnOn') AND p_corrected_on IS NOT NULL
      AND p_signature_paper IS NULL AND p_signature_kind IS NULL
    WHEN 'dsv_signature' THEN p_action::text = 'supersede' AND p_target_id IS NOT NULL
      AND p_wrong_person IS NULL AND p_corrected_registered_on IS NULL AND p_field_key IS NULL
      AND p_corrected_on IS NOT NULL
      AND p_signature_paper IN ('dsv_signed_scan', 'dsv_cancellation')
      AND p_signature_kind IN ('participant', 'customer', 'transfergesellschaft')
    ELSE false END
    AND (v_date_target OR (p_field_key IS NULL AND p_corrected_on IS NULL
      AND p_signature_paper IS NULL AND p_signature_kind IS NULL));
  v_source text := public.normalise_correction_source(p_source);
  v_roles text[];
  v_requesters text[] := '{project_lead}';
  v_corrected boolean := false;
  v_class text := 'participation_record';
  v_original date;
  v_problem text;
  v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_participation_id IS NULL OR p_reason IS NULL OR NOT coalesce(v_shape_ok, false)
     OR (p_target_id IS NULL AND p_target_kind::text <> 'field') THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF v_source IS NULL OR pg_catalog.char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'source_invalid';
  END IF;
  PERFORM public.assert_context(p_context, p_participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  r := public.lock_participation(p_participation_id);
  v_roles := public.document_staff_roles(r.id, (p_context).staff_user_id);
  IF p_target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document
    WHERE id = p_target_id AND participation_id = r.id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_requesters := CASE
      WHEN d.type::text IN ('dsv_signed_scan', 'dsv_cancellation') THEN '{project_lead,back_office}'
      WHEN d.type::text IN ('tl407_form', 'kug200b_form', 'dsv_form') THEN '{}'
      ELSE '{project_lead}' END::text[];
    v_corrected := d.invalidated_by_correction IS NOT NULL;
    v_class := d.retention_class;
  ELSIF p_target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL;
  ELSIF p_target_kind::text = 'ba_reporting_task' THEN
    SELECT * INTO t FROM public.ba_reporting_task
    WHERE id = p_target_id AND participation_id = r.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_corrected := t.superseded_by IS NOT NULL;
  ELSIF p_target_kind::text = 'dsv_signature' THEN
    -- The paper's scans, then the offer (ADR-0002's order).
    PERFORM FROM public.document
    WHERE dsv_offer_id = p_target_id AND participation_id = r.id
      AND type::text = p_signature_paper
    ORDER BY id FOR SHARE;
    PERFORM FROM public.dsv_offer WHERE id = p_target_id AND participation_id = r.id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_not_found';
    END IF;
    v_requesters := '{project_lead,back_office}';
    -- The scans' class: the signature rows are part of them (data-protection.md, DSV scans).
    v_class := 'personnel_file';
  END IF;
  IF NOT v_roles && v_requesters THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF v_corrected THEN
    RAISE EXCEPTION 'target_corrected';
  END IF;
  IF EXISTS (SELECT FROM public.evidence_correction c
             WHERE c.status::text = 'requested' AND CASE p_target_kind::text
               WHEN 'field' THEN c.participation_id = r.id AND c.field_key = p_field_key
               WHEN 'dsv_signature' THEN c.dsv_offer_id = p_target_id
                 AND c.signature_paper = p_signature_paper
                 AND c.signature_kind = p_signature_kind
               ELSE coalesce(c.document_id, c.asu_registration_id, c.ba_reporting_task_id)
                 = p_target_id END) THEN
    RAISE EXCEPTION 'correction_pending';
  END IF;
  IF p_target_kind::text = 'document' AND d.review_state::text <> 'accepted' THEN
    RAISE EXCEPTION 'document_not_accepted';
  END IF;
  IF p_target_kind::text = 'ba_reporting_task' AND t.status::text = 'pending' THEN
    RAISE EXCEPTION 'task_pending';
  END IF;
  IF p_corrected_registered_on IS NOT NULL THEN
    IF g.channel::text = 'kug_200b' THEN
      RAISE EXCEPTION 'asu_route_kug200b';
    END IF;
    IF p_corrected_registered_on > public.berlin_today() THEN
      RAISE EXCEPTION 'registered_on_in_future';
    END IF;
    IF p_corrected_registered_on = g.registered_on THEN
      RAISE EXCEPTION 'correction_unchanged';
    END IF;
  END IF;
  IF p_target_kind::text = 'field' THEN
    SELECT f.original, f.problem INTO v_original, v_problem
    FROM public.field_correction_problem(r, p_field_key, p_corrected_on) f;
  ELSIF p_target_kind::text = 'dsv_signature' THEN
    SELECT f.original, f.problem INTO v_original, v_problem
    FROM public.signature_correction_problem(p_target_id, p_signature_paper, p_signature_kind,
      p_corrected_on) f;
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;
  INSERT INTO public.evidence_correction (id, project_id, participation_id, target_kind, action,
    document_id, asu_registration_id, ba_reporting_task_id, wrong_person,
    corrected_registered_on, field_key, dsv_offer_id, signature_paper, signature_kind,
    corrected_on, original_on, reason, source, retention_class, requested_by)
  VALUES (v_id, r.project_id, r.id, p_target_kind, p_action,
    CASE WHEN p_target_kind::text = 'document' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'asu_registration' THEN p_target_id END,
    CASE WHEN p_target_kind::text = 'ba_reporting_task' THEN p_target_id END,
    p_wrong_person, p_corrected_registered_on, p_field_key,
    CASE WHEN p_target_kind::text = 'dsv_signature' THEN p_target_id END,
    p_signature_paper, p_signature_kind,
    p_corrected_on, v_original, p_reason, v_source, v_class, (p_context).staff_user_id);
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_requested', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'correctionId', v_id, 'targetKind', p_target_kind, 'action', p_action, 'reason', p_reason,
      'fieldKey', p_field_key, 'paper', p_signature_paper, 'signatureKind', p_signature_kind)),
    false);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The decision (0088), with the two date targets. An approval, at its own instant:
-- - a field: the rules again under the lock, against the original the request recorded
--   (`target_corrected` when the field changed meanwhile); then `profiling_done_on` or
--   `withdrawn_on` takes the corrected date. This is the one write of these columns besides the
--   status function, and it writes no other column: no status, status version, past snapshot,
--   audit event or entry made changes. `tl407_facts` records a corrected completion at this
--   approval;
-- - a signature: the rules again; on every accepted scan of the paper showing the signature, the
--   current row gets `superseded_by` and a linked replacement row (`correction_id`) carries the
--   corrected date, recorded now; the originals stay. For the contract's paper, the signed
--   offer's retained dates (`dsv_contract`) follow the corrected actual date.
-- Everything else as 0088.
DROP FUNCTION decide_evidence_correction(audit_context, uuid, boolean);
--> statement-breakpoint
CREATE FUNCTION decide_evidence_correction(
  p_context audit_context, p_correction_id uuid, p_approve boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.evidence_correction;
  r public.participation;
  d public.document;
  g public.asu_registration;
  t public.ba_reporting_task;
  v_new uuid;
  v_purge uuid;
  v_original date;
  v_problem text;
BEGIN
  IF p_correction_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  -- Its project, participation and target never change, so they can be read before the lock.
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_not_found';
  END IF;
  PERFORM public.assert_context(p_context, c.participation_id, '{user}');
  IF (p_context).on_behalf_of IS NOT NULL THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(public.project_lock_key(c.project_id));
  SELECT * INTO r FROM public.participation WHERE id = c.participation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT FROM public.staff_org_role o
    JOIN public.project p ON p.id = r.project_id AND p.region_id = o.region_id
    JOIN public.staff_user u ON u.id = o.staff_user_id AND u.deactivated_at IS NULL
    WHERE o.staff_user_id = (p_context).staff_user_id
      AND o.role::text = 'regional_operations_manager') THEN
    RAISE EXCEPTION 'actor_not_allowed';
  END IF;
  IF c.target_kind::text = 'document' THEN
    SELECT * INTO d FROM public.document WHERE id = c.document_id FOR UPDATE;
  ELSIF c.target_kind::text = 'asu_registration' THEN
    SELECT * INTO g FROM public.asu_registration WHERE id = c.asu_registration_id FOR UPDATE;
  ELSIF c.target_kind::text = 'ba_reporting_task' THEN
    SELECT * INTO t FROM public.ba_reporting_task WHERE id = c.ba_reporting_task_id FOR UPDATE;
  ELSIF c.target_kind::text = 'dsv_signature' THEN
    PERFORM FROM public.document
    WHERE dsv_offer_id = c.dsv_offer_id AND type::text = c.signature_paper ORDER BY id FOR UPDATE;
    PERFORM FROM public.dsv_offer WHERE id = c.dsv_offer_id FOR UPDATE;
    PERFORM FROM public.dsv_contract WHERE dsv_offer_id = c.dsv_offer_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.evidence_correction WHERE id = p_correction_id FOR UPDATE;
  IF c.status::text <> 'requested' THEN
    RAISE EXCEPTION 'correction_not_pending';
  END IF;
  IF c.requested_by = (p_context).staff_user_id THEN
    RAISE EXCEPTION 'same_person_approval';
  END IF;
  IF p_approve THEN
    IF c.target_kind::text = 'document' THEN
      IF d.deleted_at IS NOT NULL OR d.invalidated_by_correction IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      UPDATE public.document SET invalidated_by_correction = c.id,
        deleted_at = CASE WHEN c.wrong_person THEN now() END,
        deleted_by = CASE WHEN c.wrong_person THEN 'user'::public.actor_type END,
        deleted_by_staff_user_id = CASE WHEN c.wrong_person THEN (p_context).staff_user_id END,
        delete_reason = CASE WHEN c.wrong_person THEN 'wrong_person'::public.document_delete_reason END,
        file_name = CASE WHEN c.wrong_person THEN NULL ELSE file_name END
      WHERE id = d.id;
      IF c.wrong_person THEN
        v_purge := d.id;
      END IF;
    ELSIF c.target_kind::text = 'asu_registration' THEN
      IF g.superseded_by IS NOT NULL OR g.invalidated_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF c.action::text = 'invalidate' THEN
        UPDATE public.asu_registration SET invalidated_by = c.id WHERE id = g.id;
      ELSE
        UPDATE public.asu_registration SET superseded_by = c.id WHERE id = g.id;
        INSERT INTO public.asu_registration (id, project_id, participation_id, channel,
          registered_on, recorded_by, proof_kind, proof_document_id, attestation_source,
          proof_linked_by, proof_linked_at, correction_id)
        -- As 0088: the PL's attestation carries over, a BA confirmation is linked again (Q209 (3)).
        VALUES (pg_catalog.gen_random_uuid(), g.project_id, g.participation_id, g.channel,
          c.corrected_registered_on, (p_context).staff_user_id,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.proof_kind END,
          NULL,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.attestation_source END,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN g.proof_linked_by END,
          CASE WHEN g.proof_kind::text = 'ba_customer_number' THEN now() END, c.id);
      END IF;
    ELSIF c.target_kind::text = 'ba_reporting_task' THEN
      IF t.superseded_by IS NOT NULL THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      INSERT INTO public.ba_reporting_task (participation_id, project_id, reporting_kind,
        subject_date, amendment_id, replaces_task_id, correction_id)
      VALUES (t.participation_id, t.project_id, t.reporting_kind, t.subject_date, t.amendment_id,
        t.id, c.id)
      RETURNING id INTO v_new;
      UPDATE public.ba_reporting_task SET superseded_by = v_new WHERE id = t.id;
    ELSIF c.target_kind::text = 'field' THEN
      SELECT f.original, f.problem INTO v_original, v_problem
      FROM public.field_correction_problem(r, c.field_key, c.corrected_on) f;
      IF v_original IS DISTINCT FROM c.original_on THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
      END IF;
      IF c.field_key = 'profilingDoneOn' THEN
        UPDATE public.participation SET profiling_done_on = c.corrected_on WHERE id = r.id;
      ELSE
        UPDATE public.participation SET withdrawn_on = c.corrected_on WHERE id = r.id;
      END IF;
    ELSE
      SELECT f.original, f.problem INTO v_original, v_problem
      FROM public.signature_correction_problem(c.dsv_offer_id, c.signature_paper,
        c.signature_kind, c.corrected_on) f;
      IF v_original IS DISTINCT FROM c.original_on THEN
        RAISE EXCEPTION 'target_corrected';
      END IF;
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
      END IF;
      WITH superseded AS (
        UPDATE public.dsv_scan_signature s SET superseded_by = c.id
        FROM public.document x
        WHERE x.id = s.document_id AND x.dsv_offer_id = c.dsv_offer_id
          AND x.type::text = c.signature_paper AND x.review_state = 'accepted'
          AND x.deleted_at IS NULL AND x.invalidated_by_correction IS NULL
          AND s.kind = c.signature_kind AND s.superseded_by IS NULL
        RETURNING s.project_id, s.participation_id, s.document_id, s.kind)
      INSERT INTO public.dsv_scan_signature (project_id, participation_id, document_id, kind,
        signed_on, correction_id)
      SELECT project_id, participation_id, document_id, kind, c.corrected_on, c.id
      FROM superseded;
      IF c.signature_paper = 'dsv_signed_scan' THEN
        UPDATE public.dsv_contract k SET
          participant_signed_on = CASE WHEN c.signature_kind = 'participant'
            AND k.participant_signed_on = c.original_on THEN c.corrected_on
            ELSE k.participant_signed_on END,
          customer_signed_on = CASE WHEN c.signature_kind = 'customer'
            AND k.customer_signed_on = c.original_on THEN c.corrected_on
            ELSE k.customer_signed_on END,
          tg_signed_on = CASE WHEN c.signature_kind = 'transfergesellschaft'
            AND k.tg_signed_on = c.original_on THEN c.corrected_on ELSE k.tg_signed_on END
        WHERE k.dsv_offer_id = c.dsv_offer_id;
        UPDATE public.dsv_contract k SET fully_executed_on =
          greatest(k.participant_signed_on, k.customer_signed_on, k.tg_signed_on)
        WHERE k.dsv_offer_id = c.dsv_offer_id AND k.fully_executed_on IS NOT NULL;
      END IF;
    END IF;
  END IF;
  UPDATE public.evidence_correction SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.correction_status,
    decided_by = (p_context).staff_user_id, decided_at = now()
  WHERE id = c.id;
  PERFORM public.write_audit_event(r.project_id, r.id, 'evidence_correction_decided', p_context,
    NULL, NULL, NULL, NULL, NULL, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'correctionId', c.id, 'targetKind', c.target_kind, 'action', c.action, 'reason', c.reason,
      'fieldKey', c.field_key, 'paper', c.signature_paper, 'signatureKind', c.signature_kind,
      'decision', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END)), false);
  RETURN v_purge;
END $$;
--> statement-breakpoint

-- Grants as 0088: transfer_app executes the two writes and the reader; the helpers stay internal.
REVOKE ALL ON FUNCTION field_status_change, field_correction_problem, signature_correction_problem,
  request_evidence_correction, decide_evidence_correction FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION field_status_change, request_evidence_correction,
  decide_evidence_correction TO transfer_app;
