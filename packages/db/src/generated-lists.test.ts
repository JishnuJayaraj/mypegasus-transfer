import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sourcesFolder } from "./function-sources";

// ADR-0002, generated lists: the three inventories the function sources hold, read from the
// sources themselves, pinned as they were hand-written before the generator took them over.
const source = (file: string) => readFileSync(join(sourcesFolder, file), "utf8");
const quoted = (list: string | undefined) =>
  [...(list ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1]!);

/** The event types `record_audit_event` refuses, in the order of its source. */
export const refusedEventTypes = () =>
  quoted(
    source("functions/audit/record_audit_event.sql").match(
      /p_event_type::text IN \(([\s\S]*?)\) THEN/,
    )?.[1],
  );

/** The tables `retention_erase_participation` walks, in its order. */
export const erasureTables = () =>
  quoted(
    source("functions/retention/retention_erase_participation.sql").match(
      /v_tables constant text\[\] := ARRAY\[([\s\S]*?)\];/,
    )?.[1],
  );

/** Every statement that puts the evidence-only trigger on a table, whichever source holds it. */
export const evidenceOnlyTriggers = () =>
  readdirSync(join(sourcesFolder, "triggers"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8").split("\n"))
    .filter((line) => line.includes("refuse_in_evidence_set_phase"))
    .toSorted();

const pinnedRefusedEventTypes = [
  "participation_created",
  "status_changed",
  "entry_wave_assigned",
  "profiling_exception_requested",
  "profiling_exception_approved",
  "profiling_exception_rejected",
  "profiling_exception_revoked",
  "profiling_exception_superseded",
  "end_reason_corrected",
  "project_created",
  "project_changed",
  "entry_wave_created",
  "entry_wave_changed",
  "config_template_pinned",
  "config_override_changed",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "rule_relaxation_rejected",
  "rule_relaxation_withdrawn",
  "project_activated",
  "participant_data_changed",
  "participation_dates_changed",
  "project_member_added",
  "project_member_removed",
  "participant_assigned",
  "participant_unassigned",
  "activation_code_issued",
  "activation_code_delivery",
  "activation_code_handed_over",
  "activation_code_revoked",
  "privacy_notice_provided",
  "participant_activated",
  "consent_given",
  "contact_channel_added",
  "activation_code_locked",
  "one_time_code_exhausted",
  "participant_logout",
  "participant_login",
  "contact_channel_removed",
  "consent_ended",
  "contact_channels_suspended",
  "placement_agentur_set",
  "self_service_notice_acknowledged",
  "step_up_completed",
  "step_up_failed",
  "assisted_mode_started",
  "assisted_mode_ended",
  "document_opened",
  "document_added",
  "document_reviewed",
  "document_deleted",
  "document_upload_rejected",
  "reminder_queued",
  "reminder_delivery",
  "audit_history_opened",
  "appointment_created",
  "appointment_changed",
  "appointment_cancelled",
  "appointment_booked",
  "appointment_booking_cancelled",
  "attendance_recorded",
  "attendance_superseded",
  "information_delivery_confirmed",
  "attendance_conflict_escalated",
  "attendance_conflict_resolved",
  "appointment_notice_followed_up",
  "missed_appointment_resolved",
  "profiling_session_changed",
  "profiling_declarations_recorded",
  "form_generated",
  "document_quarantined",
  "document_quarantine_lifted",
  "signed_declaration_recorded",
  "asu_route_set",
  "asu_registration_recorded",
  "asu_proof_linked",
  "knowledge_date_set",
  "kug200b_offer_declined",
  "declaration_withdrawal_recorded",
  "declaration_withdrawal_ba_notified",
  "export_created",
  "export_downloaded",
  "kug200b_batch_created",
  "kug200b_batch_submitted",
  "kug200b_batch_discarded",
  "agentur_submission_recorded",
  "asu_confirmation_recorded",
  "agentur_submission_original_sent",
  "agentur_submission_rejected",
  "agentur_submission_original_retained",
  "ba_report_recorded",
  "exception_evidence_recorded",
  "evidence_correction_requested",
  "evidence_correction_decided",
  "dsv_form_generated",
  "dsv_template_pinned",
  "dsv_original_recorded",
  "entry_clarification_recorded",
  "entry_clarification_escalated",
  "entry_clarification_instructed",
  "entry_clarification_requested",
  "dsv_customer_notified",
  "tg_entry_reconciled",
  "reconciliation_reviewed",
  "reconciliation_replied",
  "settlement_dates_set",
  "funding_status_set",
  "legal_hold_placed",
  "legal_hold_released",
  "retention_applied",
];

const pinnedErasureTables = [
  "asu_registration",
  "ba_reporting_task",
  "document_link",
  "dsv_contract",
  "dsv_scan_signature",
  "entry_clarification_step",
  "kug200b_batch_member",
  "kug200b_withdrawal",
  "participant_account",
  "participant_reminder",
  "participant_session",
  "privacy_notice_delivery",
  "profiling_exception_request",
  "signed_declaration",
  "tg_entry_reconciliation_step",
  "activation_code",
  "agentur_submission",
  "appointment_booking",
  "entry_clarification",
  "evidence_correction",
  "participant_channel",
  "participation_dsv_amendment",
  "profiling_exception_evidence_record",
  "tg_entry_reconciliation",
  "consent_record",
  "document",
  "dsv_offer",
  "form_generation",
  "assisted_mode",
  "asu_record",
  "dsv_customer_notice",
  "kug200b_decline",
  "legal_hold",
  "one_time_code_challenge",
  "participant_assignment",
  "participant_details",
  "participant_health_data",
  "participant_identifier_data",
  "participant_identity",
  "participant_profile",
  "participant_profiling",
  "participant_profiling_assessment",
  "participant_profiling_health_assessment",
  "participant_residence_social_data",
  "profiling_session",
  "self_service_notice_acknowledgement",
];

const pinnedEvidenceOnlyTables = [
  "activation_code",
  "agentur_submission",
  "appointment_booking",
  "assisted_mode",
  "asu_record",
  "asu_registration",
  "ba_reporting_task",
  "consent_record",
  "document",
  "document_link",
  "dsv_contract",
  "dsv_customer_notice",
  "dsv_offer",
  "dsv_scan_signature",
  "entry_clarification",
  "entry_clarification_step",
  "evidence_correction",
  "form_generation",
  "kug200b_batch_member",
  "kug200b_decline",
  "kug200b_withdrawal",
  "one_time_code_challenge",
  "participant_account",
  "participant_assignment",
  "participant_channel",
  "participant_details",
  "participant_health_data",
  "participant_identifier_data",
  "participant_identity",
  "participant_profile",
  "participant_profiling",
  "participant_profiling_assessment",
  "participant_profiling_health_assessment",
  "participant_reminder",
  "participant_residence_social_data",
  "participant_session",
  "participation",
  "participation_dsv_amendment",
  "privacy_notice_delivery",
  "profiling_exception_evidence_record",
  "profiling_exception_request",
  "profiling_session",
  "self_service_notice_acknowledgement",
  "signed_declaration",
  "tg_entry_reconciliation",
  "tg_entry_reconciliation_step",
];

it("refuses the event types record_audit_event refused when the list was hand-written", () => {
  expect(refusedEventTypes()).toEqual(pinnedRefusedEventTypes);
});

it("erases the tables, in the order, of the hand-written list", () => {
  expect(erasureTables()).toEqual(pinnedErasureTables);
});

it("puts the same evidence-only trigger on the tables that carried it by hand", () => {
  expect(evidenceOnlyTriggers()).toEqual(
    pinnedEvidenceOnlyTables
      .map(
        (table) =>
          `CREATE OR REPLACE TRIGGER ${table}_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();`,
      )
      .toSorted(),
  );
});
