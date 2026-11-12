import { reservedEventTypes } from "@transfer/domain";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  erasureDeletionTables,
  erasureParticipationTables,
  evidenceOnlyExemptTables,
  evidenceOnlyTables,
} from "./data-catalog";
import { readSourceManifest, sourcesFolder } from "./function-sources";
import {
  generatedLists,
  generatedSources,
  renderGeneratedSources,
  staleGeneratedSources,
} from "./generated-sources";

// ADR-0002, generated lists: the three inventories the function sources hold, read from the
// sources themselves, pinned as they were hand-written before the generator took them over.
const source = (file: string) => readFileSync(join(sourcesFolder, file), "utf8");
const quoted = (list: string | undefined) =>
  [...(list ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1]!);

/** The event types `record_audit_event` refuses, in the order of its source. */
const refusedEventTypes = () =>
  quoted(
    source("functions/audit/record_audit_event.sql").match(
      /p_event_type::text IN \(([\s\S]*?)\) THEN/,
    )?.[1],
  );

/** The tables `retention_erase_participation` walks, in its order. */
const erasureTables = () =>
  quoted(
    source("functions/retention/retention_erase_participation.sql").match(
      /v_tables constant text\[\] := ARRAY\[([\s\S]*?)\];/,
    )?.[1],
  );

/** Every statement that puts the evidence-only trigger on a table, whichever source holds it. */
const evidenceOnlyTriggers = () =>
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

// The generator (ADR-0002, generated lists).
const temp = mkdtempSync(join(tmpdir(), "transfer-generated-sources-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const files = (folder: string) =>
  Object.fromEntries(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(folder.length + 1), readFileSync(path, "utf8")];
      }),
  );
/** A copy of the sources, regenerated from the given lists; returns the files that changed. */
function regenerated(name: string, lists = generatedLists()) {
  const folder = join(temp, name);
  cpSync(sourcesFolder, folder, { recursive: true });
  for (const [file, content] of Object.entries(renderGeneratedSources(lists, folder)))
    writeFileSync(join(folder, file), content);
  const before = files(sourcesFolder);
  const after = files(folder);
  return {
    folder,
    after,
    changed: Object.keys(after).filter((file) => after[file] !== before[file]),
  };
}

it("takes the lists from the domain's audit model and the data catalog", () => {
  expect(generatedLists()).toEqual({
    reservedEventTypes: [...reservedEventTypes],
    erasureTables: erasureParticipationTables.filter((name) => name !== "audit_event"),
    evidenceOnlyTables: ["participation", ...erasureParticipationTables]
      .filter((name) => name !== "audit_event" && name !== "legal_hold")
      .toSorted(),
  });
  expect(erasureDeletionTables()).toEqual(generatedLists().erasureTables);
  expect(evidenceOnlyTables()).toEqual(generatedLists().evidenceOnlyTables);
  // The exemptions are stated by hand and pinned (legal-hold-migration.int.test.ts too).
  expect(evidenceOnlyExemptTables).toEqual(["audit_event", "legal_hold"]);
  expect(erasureParticipationTables.at(-1)).toBe("audit_event");
});

it("has every generated source current, headed by its generator and listed in the manifest", () => {
  expect(staleGeneratedSources()).toEqual([]);
  expect(regenerated("current").changed).toEqual([]);
  const manifest = readSourceManifest();
  for (const file of generatedSources) {
    expect(manifest.sources).toContain(file);
    expect(source(file)).toMatch(
      /^-- Generated by packages\/db\/src\/scripts\/generate-sources\.ts \(pnpm generate\) from .+\.\n-- Do not edit: /,
    );
  }
  // No other source holds a generated list, and no template is applied as a source.
  expect(manifest.sources.filter((file) => source(file).startsWith("-- Generated by"))).toEqual(
    generatedSources.toSorted(),
  );
  expect(manifest.sources.filter((file) => file.startsWith("templates/"))).toEqual([]);
});

it("reports a stale generated source", () => {
  const { folder } = regenerated("stale");
  const file = "functions/audit/record_audit_event.sql";
  writeFileSync(
    join(folder, file),
    readFileSync(join(folder, file), "utf8").replace(
      "'retention_applied'",
      "'retention_applied', 'x'",
    ),
  );
  expect(staleGeneratedSources(generatedLists(), folder)).toEqual([file]);
  // A list the model has outgrown is stale as well.
  expect(
    staleGeneratedSources(
      { ...generatedLists(), evidenceOnlyTables: [...evidenceOnlyTables(), "tg_measure"] },
      sourcesFolder,
    ),
  ).toEqual(["triggers/generated/evidence_set_phase.sql"]);
});

it("changes only generated SQL when the model gains an event type", () => {
  const lists = generatedLists();
  const { changed, after } = regenerated("event-type", {
    ...lists,
    reservedEventTypes: [...lists.reservedEventTypes, "tg_measure_recorded"],
  });
  expect(changed).toEqual(["functions/audit/record_audit_event.sql"]);
  expect(after[changed[0]!]).toMatch(/'retention_applied',\s+'tg_measure_recorded'\n {2}\) THEN/);
});

it("changes only generated SQL when the catalog gains a participant table", () => {
  // The fixture places the new table in the erasure order by hand, as the catalog would.
  const tables = ["tg_measure", ...erasureParticipationTables];
  const { changed, after } = regenerated("table", {
    ...generatedLists(),
    erasureTables: erasureDeletionTables(tables),
    evidenceOnlyTables: evidenceOnlyTables(tables),
  });
  expect(changed.toSorted()).toEqual([
    "functions/retention/retention_erase_participation.sql",
    "triggers/generated/evidence_set_phase.sql",
  ]);
  expect(after[changed.toSorted()[0]!]).toContain("ARRAY[\n    'tg_measure', 'asu_registration',");
  expect(after[changed.toSorted()[1]!]).toContain(
    "CREATE OR REPLACE TRIGGER tg_measure_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.tg_measure FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();\n",
  );
  // Nothing but the list differs: the rest of each function is its template.
  const erase = "functions/retention/retention_erase_participation.sql";
  expect(after[erase]!.replace("'tg_measure', ", "").replace(/\s+/g, "")).toBe(
    source(erase).replace(/\s+/g, ""),
  );
});

it("refuses a name that is not an identifier, a repeated one and a template without its placeholder", () => {
  const lists = generatedLists();
  expect(() =>
    renderGeneratedSources({ ...lists, reservedEventTypes: ["x'); drop table project; --"] }),
  ).toThrow("is not an identifier");
  expect(() => renderGeneratedSources({ ...lists, evidenceOnlyTables: ["Participation"] })).toThrow(
    "is not an identifier",
  );
  expect(() =>
    renderGeneratedSources({ ...lists, erasureTables: ["document", "document"] }),
  ).toThrow("empty or repeats");
  expect(() => renderGeneratedSources({ ...lists, evidenceOnlyTables: [] })).toThrow(
    "empty or repeats",
  );
  const { folder } = regenerated("no-placeholder");
  writeFileSync(join(folder, "templates/record_audit_event.sql"), "select 1;\n");
  expect(() => renderGeneratedSources(lists, folder)).toThrow("needs /*generated:");
});
