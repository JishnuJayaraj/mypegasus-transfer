import { describe, expect, it } from "vitest";
import {
  AuditEvent,
  AuditEventType,
  configurationDependentEventTypes,
  EvidenceFingerprint,
  lifecycleEventTypes,
  reservedEventTypes,
  setupEventTypes,
  StatusField,
  statusFieldOfTrack,
} from "./events";

const projectId = "00000000-0000-4000-9000-000000000001";
const participationId = "00000000-0000-4000-a000-000000000001";
const staffUserId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-b000-000000000001";

const user = { type: "user", staffUserId, onBehalfOf: null } as const;
const system = { type: "system", job: "lifecycle.evaluate-project" } as const;
const base = { projectId, participationId, actor: user, requestId: null, jobId: null };

const statusChanged = {
  ...base,
  type: "status_changed",
  change: { field: "status", from: "contacted", to: "informed" },
  reasonCode: null,
  effectiveDate: null,
  flaggedForReview: false,
  details: {},
} as const;

const issueCodes = (input: unknown) => {
  const result = AuditEvent.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((i) => (i as { params?: { code?: string } }).params?.code ?? i.code);
};

describe("audit event types (ADR-0002)", () => {
  it("are the plan's list plus the superseded closure (round 10)", () => {
    expect(AuditEventType.options).toEqual([
      "participation_created",
      "status_changed",
      "entry_wave_assigned",
      "profiling_exception_requested",
      "profiling_exception_approved",
      "profiling_exception_rejected",
      "profiling_exception_revoked",
      "profiling_exception_superseded",
      "end_reason_corrected",
      "sensitive_read",
      "sensitive_write",
      "break_glass_access",
      "document_opened",
      "warning_confirmed",
      "export_created",
      "config_override_changed",
      "review_recorded",
      "clarification_requested",
      "project_created",
      "project_changed",
      "entry_wave_created",
      "entry_wave_changed",
      "config_template_pinned",
      "rule_relaxation_requested",
      "rule_relaxation_approved",
      "rule_relaxation_rejected",
      "rule_relaxation_withdrawn",
      "project_activated",
      "participant_data_changed",
      "import_confirmed",
      "participation_created_manually",
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
    ]);
  });

  it("reserves the lifecycle and exception types for their own functions", () => {
    expect([...lifecycleEventTypes]).toEqual(AuditEventType.options.slice(0, 9));
  });

  it("reserves the setup types too (ADR-0002, project setup)", () => {
    expect([...setupEventTypes]).toEqual([
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
    ]);
    // Person data too (PR 2f): only `write_participant_data` writes it.
    expect([...reservedEventTypes]).toEqual([
      ...lifecycleEventTypes,
      ...setupEventTypes,
      "participant_data_changed",
      "participation_dates_changed",
      // Teams and assignments (Q62, Q126): only their functions write them.
      "project_member_added",
      "project_member_removed",
      "participant_assigned",
      "participant_unassigned",
      // Activation and Art. 14 evidence: only their hardened functions write them.
      "activation_code_issued",
      "activation_code_delivery",
      "activation_code_handed_over",
      "activation_code_revoked",
      "privacy_notice_provided",
      // Portal activation (ADR-0007): only the activation functions write them.
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
      // Documents (Slice 4b): only the document functions write them, the opening included.
      "document_opened",
      "document_added",
      "document_reviewed",
      "document_deleted",
      "document_upload_rejected",
      // Reminders (Slice 5): only the reminder functions write them.
      "reminder_queued",
      "reminder_delivery",
      // The history's opening (Q157): only `audit_history` writes it.
      "audit_history_opened",
      // Appointments (Slice 5b): only the appointment functions write them.
      "appointment_created",
      "appointment_changed",
      "appointment_cancelled",
      "appointment_booked",
      "appointment_booking_cancelled",
    ]);
  });

  it("names the status columns of the three tracks", () => {
    expect(StatusField.options).toEqual(["status", "profiling_status", "dsv_status"]);
    expect(statusFieldOfTrack).toEqual({
      main: "status",
      profiling: "profiling_status",
      dsv: "dsv_status",
    });
  });

  it("has a schema for every type", () => {
    const covered = AuditEvent.options.map((o) => o.shape.type.value);
    expect(new Set(covered)).toEqual(new Set(AuditEventType.options));
  });
});

// regional-variation.md, base defaults (round 23): this exact list; a type joins
// `configurationDependentEventTypes` with its PR.
const r26 = [
  "project_activated",
  "config_template_pinned",
  "config_override_changed",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "import_confirmed",
  // round 33: manual creation resolves the import's required targets
  "participation_created_manually",
  // Q139: the placement Agentur's chain is checked like a pin's
  "placement_agentur_set",
];

describe("configuration-dependent events (Q107)", () => {
  it("are exactly the listed types that exist so far", () => {
    const existing = r26.filter((type) => (AuditEventType.options as string[]).includes(type));
    expect([...configurationDependentEventTypes].toSorted()).toEqual(existing.toSorted());
  });

  it("each require the base-defaults version", () => {
    for (const type of configurationDependentEventTypes) {
      const option = AuditEvent.options.find((o) => o.shape.type.value === type)!;
      const details = option.shape.details as unknown as { shape: Record<string, unknown> };
      expect(Object.keys(details.shape)).toContain("baseDefaultsVersion");
      expect(
        (details as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse({})
          .success,
      ).toBe(false);
    }
  });
});

describe("actors (ADR-0002)", () => {
  it.each([
    ["a user", user],
    ["a user in assisted mode", { ...user, onBehalfOf: participationId }],
    ["a participant", { type: "participant", participationId }],
    ["a system job", system],
    ["the seed", { type: "system", job: "seed" }],
  ])("accepts %s", (_label, actor) => {
    expect(AuditEvent.safeParse({ ...statusChanged, actor }).success).toBe(true);
  });

  it.each([
    ["a user without a staff id", { type: "user", onBehalfOf: null }],
    [
      "on behalf of for a participant",
      { type: "participant", participationId, onBehalfOf: otherId },
    ],
    ["on behalf of for the system", { ...system, onBehalfOf: otherId }],
    ["a system job with free text", { type: "system", job: "Nachtlauf für Werk Nord" }],
    ["a system actor with a staff id", { ...system, staffUserId }],
  ])("rejects %s", (_label, actor) => {
    expect(AuditEvent.safeParse({ ...statusChanged, actor }).success).toBe(false);
  });

  it("keeps correlation ids to id characters", () => {
    expect(AuditEvent.safeParse({ ...statusChanged, requestId: otherId }).success).toBe(true);
    expect(AuditEvent.safeParse({ ...statusChanged, jobId: "not an id" }).success).toBe(false);
  });
});

describe("status_changed", () => {
  it.each([
    ["status", "contacted", "unreachable"],
    ["profiling_status", "profiling_accepted", "profiling_in_progress"],
    ["dsv_status", "dsv_offered", "dsv_signed"],
  ])("takes the values of its field (%s)", (field, from, to) => {
    expect(AuditEvent.safeParse({ ...statusChanged, change: { field, from, to } }).success).toBe(
      true,
    );
    expect(
      AuditEvent.safeParse({ ...statusChanged, change: { field, from: to, to: "withdrawn_x" } })
        .success,
    ).toBe(false);
  });

  it("rejects a value of another track", () => {
    const change = { field: "dsv_status", from: "dsv_offered", to: "informed" };
    expect(AuditEvent.safeParse({ ...statusChanged, change }).success).toBe(false);
  });

  const withdrawal = {
    ...statusChanged,
    change: { field: "status", from: "contacted", to: "withdrawn" },
    reasonCode: "not_informed",
    effectiveDate: "2027-04-16",
    details: { secondaryReasons: ["no_response"] },
  } as const;

  it("carries the end reason of a withdrawal or exit, with secondary reasons", () => {
    expect(issueCodes(withdrawal)).toEqual([]);
    expect(issueCodes({ ...withdrawal, reasonCode: null })).toEqual(["reason_required"]);
    expect(issueCodes({ ...statusChanged, reasonCode: "other" })).toEqual(["reason_unexpected"]);
    expect(issueCodes({ ...statusChanged, details: { secondaryReasons: ["other"] } })).toEqual([
      "reason_unexpected",
    ]);
  });

  it("never carries the special-category end reason (Q66)", () => {
    const exit = {
      ...withdrawal,
      change: { field: "status", from: "active_in_tg", to: "exited" },
      details: {},
    };
    const illness = "long_term_illness_reduced_earning_capacity";
    expect(issueCodes({ ...exit, reasonCode: "placed_permanent" })).toEqual([]);
    expect(issueCodes({ ...exit, reasonCode: illness })).toEqual(["reason_not_storable"]);
    expect(issueCodes({ ...withdrawal, details: { secondaryReasons: [illness] } })).toEqual([
      "reason_not_storable",
    ]);
  });

  const entry = {
    ...statusChanged,
    actor: system,
    change: { field: "status", from: "informed", to: "active_in_tg" },
    effectiveDate: "2027-03-01",
    details: { entryKind: "scheduled_entry_catchup", scheduledAt: "2027-03-01T03:15:00.000Z" },
  } as const;

  it("carries the entry kind of a TG entry, and flags reconciliations", () => {
    expect(issueCodes(entry)).toEqual([]);
    const reconciliation = {
      ...entry,
      actor: user,
      flaggedForReview: true,
      details: { entryKind: "reconciliation" },
    };
    expect(issueCodes(reconciliation)).toEqual([]);
    expect(issueCodes({ ...reconciliation, flaggedForReview: false })).toEqual(["flag_mismatch"]);
    expect(issueCodes({ ...entry, flaggedForReview: true })).toEqual(["flag_mismatch"]);
    expect(issueCodes({ ...entry, details: {} })).toEqual(["entry_kind_required"]);
    expect(issueCodes({ ...statusChanged, details: { entryKind: "scheduled_entry" } })).toEqual([
      "entry_kind_unexpected",
    ]);
  });

  it("allows only IDs, codes and dates in its details", () => {
    expect(issueCodes({ ...statusChanged, details: { note: "Teilnehmer krank" } })).toEqual([
      "unrecognized_keys",
    ]);
    expect(
      issueCodes({
        ...statusChanged,
        change: { field: "dsv_status", from: "dsv_expired", to: "dsv_offered" },
        details: { offerDeadline: "2027-03-31" },
      }),
    ).toEqual([]);
  });
});

// Every exception event identifies its request record; only the request names its opaque
// evidence record, never the fingerprint or contents (Q94, round 17).
const ofRequest = { profilingExceptionRequestId: "00000000-0000-4000-8000-0000000000c1" };
const requested = { ...ofRequest, evidenceRecordId: "00000000-0000-4000-8000-0000000000d1" };

describe("EvidenceFingerprint (round 17)", () => {
  it("names the hash and the canonicalisation version", () => {
    expect(EvidenceFingerprint.safeParse(`sha256:v1:${"0a".repeat(32)}`).success).toBe(true);
  });

  it.each([
    ["no canonicalisation version", `sha256:${"0a".repeat(32)}`],
    ["upper-case hex", `sha256:v1:${"0A".repeat(32)}`],
    ["a short digest", `sha256:v1:${"0a".repeat(31)}`],
    ["another hash", `md5:v1:${"0a".repeat(32)}`],
    ["an unversioned v", `sha256:v:${"0a".repeat(32)}`],
  ])("rejects %s", (_label, value) => {
    expect(EvidenceFingerprint.safeParse(value).success).toBe(false);
  });
});

describe("the other event types", () => {
  it.each([
    ["participation_created", { to: "imported", details: { entryWaveId: otherId } }],
    ["participation_created", { to: "imported", details: {} }],
    ["entry_wave_assigned", { details: { waveId: otherId, previousWaveId: null } }],
    ["profiling_exception_requested", { reasonCode: "force_majeure", details: requested }],
    ["profiling_exception_approved", { details: ofRequest }],
    ["profiling_exception_rejected", { details: ofRequest }],
    ["profiling_exception_revoked", { details: ofRequest }],
    [
      "profiling_exception_superseded",
      {
        actor: system,
        reasonCode: "profiling_closed",
        details: { ...ofRequest, statusChangeId: otherId },
      },
    ],
    [
      "end_reason_corrected",
      {
        from: "no_response",
        to: "placed_direct",
        details: { previousSource: "system", secondaryReasons: ["no_response"] },
      },
    ],
    ["sensitive_read", { details: { key: "healthRestrictions" } }],
    ["sensitive_write", { details: { key: "custom.beispiel_zusatznachweis_nr" } }],
    [
      "break_glass_access",
      {
        reasonCode: "case_review",
        flaggedForReview: true,
        details: { action: "read", target: { kind: "field", category: "health" } },
      },
    ],
    [
      "break_glass_access",
      {
        reasonCode: "case_review",
        flaggedForReview: true,
        details: {
          action: "open_document",
          target: { kind: "document", documentType: "asu_proof", category: "identifiers" },
        },
      },
    ],
    [
      "break_glass_access",
      {
        reasonCode: "case_review",
        flaggedForReview: true,
        details: { action: "read", target: { kind: "audit", stream: "case" } },
      },
    ],
    ["document_opened", { details: { documentType: "dsv_signed_scan", documentId: otherId } }],
    ["warning_confirmed", { reasonCode: "implausible_date", details: {} }],
    ["export_created", { participationId: null, reasonCode: "monthly_report", details: {} }],
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 1,
          change: "agentur_setting_set",
          agenturKey: "beispielstadt-ost",
          settingKeys: ["agentur_submission.leadTimeDays"],
          source: "email_agentur",
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 2,
          change: "agentur_setting_removed",
          agenturKey: "beispielstadt-ost",
          settingKeys: ["agentur_submission.leadTimeDays"],
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 3,
          change: "relaxation_added",
          ruleId: "base-import-birthDate",
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 4,
          change: "relaxation_removed",
          ruleId: "base-import-birthDate",
          baseDefaultsVersion: 1,
        },
      },
    ],
    // A migration's review (regional-variation.md, migration): the removed keys, and the kept ones
    // when there are any.
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 5,
          change: "agentur_setting_reviewed",
          agenturKey: "beispielstadt-nord",
          settingKeys: ["agentur_submission.leadTimeDays"],
          keptSettingKeys: ["agentur_submission.submissionChannel"],
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "rule_relaxation_requested",
      {
        participationId: null,
        reasonCode: "source_data_not_provided",
        details: {
          relaxationRequestId: otherId,
          ruleId: "base-import-birthDate",
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "rule_relaxation_approved",
      {
        participationId: null,
        reasonCode: "collected_outside_platform",
        details: {
          relaxationRequestId: otherId,
          ruleId: "beispielstadt-sued-private-email",
          version: 2,
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "rule_relaxation_rejected",
      {
        participationId: null,
        details: { relaxationRequestId: otherId, ruleId: "base-import-address" },
      },
    ],
    [
      "rule_relaxation_withdrawn",
      {
        participationId: null,
        details: { relaxationRequestId: otherId, ruleId: "base-import-address" },
      },
    ],
    ["review_recorded", { reasonCode: "no_concern", details: { reviewedEventId: otherId } }],
    ["clarification_requested", { details: { reviewedEventId: otherId } }],
    ["project_created", { participationId: null, details: { type: "ta_tg" } }],
    ["project_changed", { participationId: null, details: { fields: ["name", "customerName"] } }],
    [
      "project_changed",
      { participationId: null, details: { fields: ["regionId"], regionId: otherId } },
    ],
    [
      "project_member_added",
      { participationId: null, details: { staffUserId: otherId, role: "consultant" } },
    ],
    [
      "project_member_removed",
      {
        participationId: null,
        reasonCode: "member_removed",
        details: { staffUserId: otherId, role: "project_lead" },
      },
    ],
    [
      "project_member_removed",
      {
        participationId: null,
        reasonCode: "account_deactivated",
        details: { staffUserId: otherId, role: "back_office" },
      },
    ],
    ["participant_assigned", { details: { staffUserId: otherId, assignmentId: otherId } }],
    [
      "participant_unassigned",
      {
        reasonCode: "consultant_removed",
        details: { staffUserId: otherId, assignmentId: otherId },
      },
    ],
    ["project_changed", { participationId: null, details: { fields: ["type"], type: "ta_only" } }],
    [
      "project_changed",
      {
        participationId: null,
        details: { fields: ["projectAgenturKey"], projectAgenturKey: "beispielstadt-nord" },
      },
    ],
    [
      "config_template_pinned",
      {
        participationId: null,
        details: { agenturKey: "beispielstadt-nord", version: 1, baseDefaultsVersion: 1 },
      },
    ],
    [
      "config_template_pinned",
      {
        participationId: null,
        details: {
          agenturKey: "beispielstadt-nord",
          version: 2,
          previousVersion: 1,
          baseDefaultsVersion: 1,
        },
      },
    ],
    ["entry_wave_created", { participationId: null, details: { waveId: otherId } }],
    [
      "entry_wave_created",
      { participationId: null, details: { waveId: otherId, latestEntryDate: "2027-03-15" } },
    ],
    ["participant_data_changed", { details: { fields: ["lastName", "address", "phone"] } }],
    // Contractual dates (process-and-lifecycle.md, "BA reporting"): old and new effective dates,
    // the amendment, the tasks.
    [
      "participation_dates_changed",
      {
        details: {
          oldTgStart: "2027-04-01",
          newTgStart: "2027-04-15",
          amendmentId: otherId,
          reportingKinds: ["later_entry"],
        },
      },
    ],
    [
      "participation_dates_changed",
      {
        details: {
          oldTgEnd: "2028-03-31",
          newTgEnd: "2028-02-29",
          reportingKinds: ["planned_end_changed"],
        },
      },
    ],
    // A participation created by hand: the base-defaults version (Q107, round 33).
    ["participation_created_manually", { details: { baseDefaultsVersion: 1 } }],
    // A confirmed import: counts and the base-defaults version (Q107), project-level.
    [
      "import_confirmed",
      {
        participationId: null,
        details: { created: 3, updated: 2, unchanged: 0, skipped: 1, baseDefaultsVersion: 1 },
      },
    ],
    [
      "project_activated",
      {
        participationId: null,
        details: {
          projectAgenturKey: "beispielstadt-nord",
          projectAgenturVersion: 1,
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "entry_wave_changed",
      {
        participationId: null,
        details: {
          waveId: otherId,
          fields: ["name", "signingDeadline", "latestEntryDate"],
          dates: {
            signingDeadline: { from: "2027-02-15", to: "2027-02-20" },
            latestEntryDate: { from: "2027-03-15", to: null },
          },
        },
      },
    ],
    [
      "entry_wave_changed",
      { participationId: null, details: { waveId: otherId, fields: ["code"] } },
    ],
  ])("accept a valid %s", (type, fields) => {
    expect(issueCodes({ ...base, type, ...fields })).toEqual([]);
  });

  it.each([
    ["participation_created", { to: "contacted", details: {} }],
    ["participation_created", { participationId: null, to: "imported", details: {} }],
    ["entry_wave_assigned", { details: { waveId: "W1", previousWaveId: null } }],
    ["profiling_exception_requested", { reasonCode: "late_joiner", details: requested }],
    [
      "profiling_exception_requested",
      { reasonCode: "force_majeure", details: { ...requested, text: "x" } },
    ],
    [
      "profiling_exception_requested",
      {
        reasonCode: "force_majeure",
        details: { ...requested, evidenceFingerprint: `sha256:v1:${"ab".repeat(32)}` },
      },
    ],
    ["profiling_exception_requested", { reasonCode: "force_majeure", details: ofRequest }],
    ["profiling_exception_approved", { details: {} }],
    ["profiling_exception_revoked", { details: { ...ofRequest, reason: "x" } }],
    ["profiling_exception_superseded", { reasonCode: "profiling_closed", details: ofRequest }],
    [
      "end_reason_corrected",
      {
        from: "no_response",
        to: "long_term_illness_reduced_earning_capacity",
        details: { previousSource: "system", secondaryReasons: [] },
      },
    ],
    ["sensitive_read", { details: { key: "healthRestrictions", value: "x" } }],
    ["sensitive_write", { details: { key: "Diagnose: Rücken" } }],
    [
      "break_glass_access",
      {
        reasonCode: "case_review",
        flaggedForReview: false,
        details: { action: "read", target: { kind: "field", category: "health" } },
      },
    ],
    [
      "break_glass_access",
      {
        reasonCode: "case_review",
        flaggedForReview: true,
        details: { action: "list", target: { kind: "field", category: "health" } },
      },
    ],
    [
      "break_glass_access",
      { reasonCode: "Kollege bat darum", flaggedForReview: true, details: {} },
    ],
    ["warning_confirmed", { reasonCode: "implausible_date", details: { comment: "ok" } }],
    ["review_recorded", { reasonCode: null, details: {} }],
    ["project_created", { details: { type: "ta_tg" } }],
    ["project_created", { participationId: null, details: { type: "ta_tg", name: "Werk Nord" } }],
    ["project_changed", { participationId: null, details: { fields: [] } }],
    ["project_changed", { participationId: null, details: { fields: ["regionId"] } }],
    [
      "project_member_added",
      { participationId: null, details: { staffUserId: otherId, role: "admin" } },
    ],
    ["project_member_added", { details: { staffUserId: otherId, role: "consultant" } }],
    [
      "project_member_removed",
      {
        participationId: null,
        reasonCode: "unassigned",
        details: { staffUserId: otherId, role: "consultant" },
      },
    ],
    [
      "participant_assigned",
      { participationId: null, details: { staffUserId: otherId, assignmentId: otherId } },
    ],
    [
      "participant_unassigned",
      { reasonCode: "removed", details: { staffUserId: otherId, assignmentId: otherId } },
    ],
    ["project_changed", { participationId: null, details: { fields: ["signingDeadline"] } }],
    [
      "project_changed",
      {
        participationId: null,
        details: { fields: ["projectAgenturKey"], projectAgenturKey: "Nord Süd" },
      },
    ],
    [
      "config_template_pinned",
      { details: { agenturKey: "beispielstadt-nord", version: 1, baseDefaultsVersion: 1 } },
    ],
    [
      "config_template_pinned",
      {
        participationId: null,
        details: {
          agenturKey: "beispielstadt-nord",
          version: 1,
          baseDefaultsVersion: 1,
          sha256: "ab",
        },
      },
    ],
    // An override change names keys and the source, never values; the source only when set.
    ...(
      [
        { source: undefined },
        { change: "agentur_setting_removed" },
        { settingKeys: [] },
        { settingKeys: ["agentur_submission.leadTimeDays=7"] },
        { baseDefaultsVersion: undefined },
        { version: 0 },
        { value: "upload" },
      ] as object[]
    ).map(
      (change) =>
        [
          "config_override_changed",
          {
            participationId: null,
            details: {
              version: 1,
              change: "agentur_setting_set",
              agenturKey: "beispielstadt-ost",
              settingKeys: ["agentur_submission.leadTimeDays"],
              source: "email_agentur",
              baseDefaultsVersion: 1,
              ...change,
            },
          },
        ] as [string, object],
    ),
    // A relaxation change names the rule and nothing of a setting; a setting change no rule.
    ...(
      [
        { ruleId: undefined },
        { agenturKey: "beispielstadt-ost" },
        { settingKeys: ["agentur_submission.leadTimeDays"] },
        { source: "email_agentur" },
        { ruleId: "Regel für Frau M." },
        { baseDefaultsVersion: undefined },
      ] as object[]
    ).map(
      (change) =>
        [
          "config_override_changed",
          {
            participationId: null,
            details: {
              version: 2,
              change: "relaxation_added",
              ruleId: "base-import-address",
              baseDefaultsVersion: 1,
              ...change,
            },
          },
        ] as [string, object],
    ),
    [
      "config_override_changed",
      {
        participationId: null,
        details: {
          version: 1,
          change: "agentur_setting_removed",
          agenturKey: "beispielstadt-ost",
          settingKeys: ["agentur_submission.leadTimeDays"],
          ruleId: "base-import-address",
          baseDefaultsVersion: 1,
        },
      },
    ],
    // Kept keys belong to a review only; a review names no source.
    ...(
      [
        { change: "agentur_setting_set", source: "email_agentur" },
        { change: "agentur_setting_removed" },
        { source: "email_agentur" },
        { keptSettingKeys: [] },
      ] as object[]
    ).map(
      (change) =>
        [
          "config_override_changed",
          {
            participationId: null,
            details: {
              version: 1,
              change: "agentur_setting_reviewed",
              agenturKey: "beispielstadt-nord",
              settingKeys: ["agentur_submission.leadTimeDays"],
              keptSettingKeys: ["agentur_submission.submissionChannel"],
              baseDefaultsVersion: 1,
              ...change,
            },
          },
        ] as [string, object],
    ),
    // Relaxation events: a controlled reason code where there is one, ids only, the base-defaults
    // version.
    [
      "rule_relaxation_requested",
      {
        participationId: null,
        reasonCode: "too_much_work",
        details: {
          relaxationRequestId: otherId,
          ruleId: "base-import-address",
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "rule_relaxation_requested",
      {
        participationId: null,
        reasonCode: "source_data_not_provided",
        details: { relaxationRequestId: otherId, ruleId: "base-import-address" },
      },
    ],
    [
      "rule_relaxation_approved",
      {
        participationId: null,
        reasonCode: "source_data_not_provided",
        details: {
          relaxationRequestId: otherId,
          ruleId: "base-import-address",
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "rule_relaxation_rejected",
      {
        participationId: null,
        details: { relaxationRequestId: otherId, ruleId: "base-import-address", comment: "nein" },
      },
    ],
    [
      "rule_relaxation_withdrawn",
      { details: { relaxationRequestId: otherId, ruleId: "base-import-address" } },
    ],
    [
      "project_activated",
      {
        participationId: null,
        details: { projectAgenturKey: "beispielstadt-nord", projectAgenturVersion: 1 },
      },
    ],
    [
      "project_activated",
      {
        details: {
          projectAgenturKey: "beispielstadt-nord",
          projectAgenturVersion: 1,
          baseDefaultsVersion: 1,
        },
      },
    ],
    [
      "project_activated",
      {
        participationId: null,
        details: {
          projectAgenturKey: "Werk Nord",
          projectAgenturVersion: 1,
          baseDefaultsVersion: 1,
        },
      },
    ],
    // An import's counts need the base-defaults version, are numbers and carry no file facts.
    [
      "import_confirmed",
      { participationId: null, details: { created: 1, updated: 0, unchanged: 0, skipped: 0 } },
    ],
    [
      "import_confirmed",
      {
        participationId: null,
        details: { created: -1, updated: 0, unchanged: 0, skipped: 0, baseDefaultsVersion: 1 },
      },
    ],
    [
      "import_confirmed",
      {
        participationId: null,
        details: {
          created: 1,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          baseDefaultsVersion: 1,
          fileName: "teilnehmer.csv",
        },
      },
    ],
    [
      "import_confirmed",
      {
        details: { created: 1, updated: 0, unchanged: 0, skipped: 0, baseDefaultsVersion: 1 },
      },
    ],
    // Manual creation belongs to a participation and names nothing but the version.
    ["participation_created_manually", { details: {} }],
    [
      "participation_created_manually",
      { participationId: null, details: { baseDefaultsVersion: 1 } },
    ],
    [
      "participation_created_manually",
      { details: { baseDefaultsVersion: 1, personnelNumber: "BSP-0001" } },
    ],
    // Person data: the changed fields of a participation, never a value (PR 2f).
    ["participant_data_changed", { details: { fields: [] } }],
    // A date change names its tasks, its dates as dates and no free text.
    ["participation_dates_changed", { details: { reportingKinds: [] } }],
    [
      "participation_dates_changed",
      { details: { newTgEnd: "29.02.2028", reportingKinds: ["planned_end_changed"] } },
    ],
    [
      "participation_dates_changed",
      { details: { reportingKinds: ["early_exit"], note: "per Telefon" } },
    ],
    [
      "participation_dates_changed",
      { participationId: null, details: { reportingKinds: ["later_entry"] } },
    ],
    ["participant_data_changed", { details: { fields: ["addressStreet"] } }],
    ["participant_data_changed", { details: { fields: ["phone"], phone: "030 1234567" } }],
    ["participant_data_changed", { participationId: null, details: { fields: ["phone"] } }],
    // Free text (the wave name) never enters the trail; dates only with their changed key.
    ["entry_wave_created", { participationId: null, details: { waveId: otherId, name: "W" } }],
    ["entry_wave_created", { details: { waveId: otherId } }],
    ["entry_wave_changed", { participationId: null, details: { waveId: otherId, fields: [] } }],
    [
      "entry_wave_changed",
      { participationId: null, details: { waveId: otherId, fields: ["name"], name: "Welle" } },
    ],
    [
      "entry_wave_changed",
      { participationId: null, details: { waveId: otherId, fields: ["latestEntryDate"] } },
    ],
    [
      "entry_wave_changed",
      {
        participationId: null,
        details: {
          waveId: otherId,
          fields: ["code"],
          dates: { defaultTgEnd: { from: null, to: "2028-02-29" } },
        },
      },
    ],
  ])("reject an invalid %s", (type, fields) => {
    expect(AuditEvent.safeParse({ ...base, type, ...fields }).success).toBe(false);
  });

  it("checks the end-reason correction like the operation does", () => {
    const correction = {
      ...base,
      type: "end_reason_corrected",
      from: "no_response",
      to: "no_response",
      details: { previousSource: "system", secondaryReasons: [] },
    };
    expect(issueCodes(correction)).toEqual(["reason_unchanged"]);
    const illness = "long_term_illness_reduced_earning_capacity";
    expect(
      issueCodes({
        ...correction,
        to: "other",
        details: { ...correction.details, secondaryReasons: [illness] },
      }),
    ).toEqual(["reason_not_storable"]);
  });
});

describe("portal activation events (ADR-0007)", () => {
  const participant = { type: "participant", participationId } as const;
  const portalJob = { type: "system", job: "portal-activation" } as const;

  it.each([
    [
      "participant_activated",
      participant,
      {
        activationCodeId: otherId,
        identityAssurance: "photo_id",
        noticeVersion: "art14-activation:v1",
        language: "en",
      },
    ],
    [
      "consent_given",
      participant,
      {
        consentId: otherId,
        channelId: otherId,
        purpose: "portal_contact",
        textVersion: "portal-contact-consent:v1",
        language: "de",
      },
    ],
    [
      "contact_channel_added",
      participant,
      { channelId: otherId, kind: "sms", verifiedBy: "activation_link" },
    ],
    ["activation_code_locked", portalJob, { activationCodeId: otherId }],
    [
      "one_time_code_exhausted",
      portalJob,
      { challengeId: otherId, purpose: "channel_verification" },
    ],
    ["participant_logout", participant, {}],
    // The notice evidence of PR 3d with its real version string.
    [
      "privacy_notice_provided",
      user,
      {
        noticeDeliveryId: otherId,
        noticeVersion: "art14-activation:v1",
        language: "de",
        method: "letter",
      },
    ],
  ] as const)("accept %s with ids and codes only", (type, actor, details) => {
    expect(issueCodes({ ...base, type, actor, details })).toEqual([]);
    // Never an address or a code beside them.
    expect(
      AuditEvent.safeParse({ ...base, type, actor, details: { ...details, address: "x" } }).success,
    ).toBe(false);
  });

  it("names the participation of every activation event", () => {
    expect(
      AuditEvent.safeParse({
        ...base,
        type: "participant_logout",
        actor: participant,
        participationId: null,
        details: {},
      }).success,
    ).toBe(false);
  });
});

describe("portal login, channel and recovery events (Q130, ADR-0007, Q123)", () => {
  const participant = { type: "participant", participationId } as const;

  it.each([
    ["participant_login", participant, null, { method: "one_time_code", channelId: otherId }],
    [
      "participant_login",
      participant,
      null,
      { method: "recovery_code", activationCodeId: otherId },
    ],
    [
      "contact_channel_removed",
      participant,
      "consent_revoked",
      { channelId: otherId, kind: "email" },
    ],
    [
      "consent_ended",
      participant,
      "lost_access_replaced",
      { consentId: otherId, channelId: otherId, purpose: "portal_contact" },
    ],
    [
      "contact_channels_suspended",
      user,
      "lost_access",
      { activationCodeId: otherId, channelIds: [otherId] },
    ],
    [
      "contact_channels_suspended",
      user,
      "lost_access",
      { activationCodeId: otherId, channelIds: [] },
    ],
  ] as const)("accept %s with ids and codes only", (type, actor, reasonCode, details) => {
    const event = { ...base, type, actor, details, ...(reasonCode && { reasonCode }) };
    expect(issueCodes(event)).toEqual([]);
    expect(AuditEvent.safeParse({ ...event, details: { ...details, address: "x" } }).success).toBe(
      false,
    );
  });

  it("ties the login method to what it names", () => {
    const login = { ...base, type: "participant_login", actor: participant };
    expect(issueCodes({ ...login, details: { method: "one_time_code" } })).toEqual([
      "method_mismatch",
    ]);
    expect(
      issueCodes({
        ...login,
        details: { method: "recovery_code", activationCodeId: otherId, channelId: otherId },
      }),
    ).toEqual(["method_mismatch"]);
  });

  it("needs the reason of every removal, end and suspension", () => {
    expect(
      AuditEvent.safeParse({
        ...base,
        type: "consent_ended",
        actor: participant,
        details: { consentId: otherId, channelId: otherId, purpose: "portal_contact" },
      }).success,
    ).toBe(false);
    expect(
      AuditEvent.safeParse({
        ...base,
        type: "contact_channel_removed",
        actor: participant,
        reasonCode: "lost_access",
        details: { channelId: otherId, kind: "sms" },
      }).success,
    ).toBe(false);
  });
});

describe("reminders (data-protection.md, reminders)", () => {
  const job = { type: "system", job: "reminders.send" } as const;
  const queued = {
    ...base,
    type: "reminder_queued",
    details: { reminderId: otherId, batchId: otherId, kind: "open_items", channelKind: "email" },
  };
  const delivery = {
    ...base,
    type: "reminder_delivery",
    actor: job,
    reasonCode: null,
    details: { reminderId: otherId, outcome: "sent" },
  };

  it("record the queued reminder and its final state, ids and codes only", () => {
    expect(issueCodes(queued)).toEqual([]);
    expect(issueCodes(delivery)).toEqual([]);
    expect(
      issueCodes({
        ...delivery,
        reasonCode: "consent_ended",
        details: { reminderId: otherId, outcome: "cancelled" },
      }),
    ).toEqual([]);
  });

  it("name a cancellation's reason and no other, never an address or a provider error", () => {
    expect(issueCodes({ ...delivery, reasonCode: "nothing_open" })).toEqual(["reason_mismatch"]);
    expect(
      issueCodes({ ...delivery, details: { reminderId: otherId, outcome: "cancelled" } }),
    ).toEqual(["reason_mismatch"]);
    for (const bad of [
      { ...queued, details: { ...queued.details, address: "x@example.invalid" } },
      { ...queued, actor: job },
      { ...delivery, actor: user },
      { ...delivery, details: { ...delivery.details, error: "timeout" } },
      { ...delivery, participationId: null },
    ]) {
      expect(AuditEvent.safeParse(bad).success).toBe(false);
    }
  });

  it("end a v1 consent superseded by v2, never as a withdrawal", () => {
    const participant = { type: "participant", participationId } as const;
    expect(
      issueCodes({
        ...base,
        type: "consent_ended",
        actor: participant,
        reasonCode: "superseded",
        details: { consentId: otherId, channelId: otherId, purpose: "portal_contact" },
      }),
    ).toEqual([]);
  });
});

describe("assisted mode (Q136, ADR-0007)", () => {
  const started = {
    ...base,
    type: "assisted_mode_started",
    details: { assistedModeId: otherId, how: "phone" },
  };
  const ended = {
    ...base,
    type: "assisted_mode_ended",
    details: { assistedModeId: otherId, endReason: "staff_session_ended" },
  };

  it("records who opened it for whom, how, and why it ended; codes only", () => {
    expect(issueCodes(started)).toEqual([]);
    expect(issueCodes({ ...started, details: { ...started.details, how: "in_person" } })).toEqual(
      [],
    );
    expect(issueCodes(ended)).toEqual([]);
    expect(issueCodes({ ...ended, details: { ...ended.details, endReason: "ended" } })).toEqual([]);
  });

  it("is a staff user's own action on a participation, without free text", () => {
    for (const bad of [
      { ...started, details: { ...started.details, how: "video" } },
      { ...started, details: { ...started.details, note: "asked for help" } },
      { ...started, actor: { ...user, onBehalfOf: participationId } },
      { ...started, actor: { type: "participant", participationId } },
      { ...started, participationId: null },
      { ...ended, details: { ...ended.details, endReason: "timeout" } },
    ]) {
      expect(AuditEvent.safeParse(bad).success).toBe(false);
    }
  });
});

describe("documents (data-protection.md, uploads; Q144, Q146)", () => {
  const participant = { type: "participant", participationId } as const;
  const assisted = { ...user, onBehalfOf: participationId };
  const ofDocument = { documentId: otherId, documentType: "cv" };
  const added = { ...base, type: "document_added", details: { ...ofDocument, source: "staff" } };
  const reviewed = {
    ...base,
    type: "document_reviewed",
    reasonCode: "unreadable",
    details: { ...ofDocument, decision: "rejected" },
  };
  const deleted = {
    ...base,
    type: "document_deleted",
    reasonCode: "wrong_person",
    details: ofDocument,
  };
  const rejected = {
    ...base,
    type: "document_upload_rejected",
    reasonCode: "file_infected",
    details: { documentType: "cv" },
  };

  it("records the document's id, type and source, codes only", () => {
    expect(issueCodes(added)).toEqual([]);
    expect(
      issueCodes({ ...added, actor: participant, details: { ...ofDocument, source: "portal" } }),
    ).toEqual([]);
    expect(
      issueCodes({ ...added, actor: assisted, details: { ...ofDocument, source: "assisted" } }),
    ).toEqual([]);
    expect(
      issueCodes({
        ...reviewed,
        reasonCode: null,
        details: { ...ofDocument, decision: "accepted" },
      }),
    ).toEqual([]);
    expect(issueCodes(reviewed)).toEqual([]);
    expect(issueCodes(deleted)).toEqual([]);
    expect(issueCodes({ ...deleted, actor: participant, reasonCode: null })).toEqual([]);
    expect(issueCodes(rejected)).toEqual([]);
    expect(issueCodes({ ...rejected, actor: assisted, reasonCode: "file_unscannable" })).toEqual(
      [],
    );
  });

  it("refuses a wrong source, a reason that doesn't fit and any file name", () => {
    expect(issueCodes({ ...added, actor: participant })).toEqual(["source_mismatch"]);
    expect(issueCodes({ ...added, actor: assisted })).toEqual(["source_mismatch"]);
    const seedJob = { type: "system", job: "seed" };
    expect(issueCodes({ ...added, actor: seedJob })).toEqual(["source_mismatch"]);
    expect(issueCodes({ ...reviewed, reasonCode: null })).toEqual(["reason_mismatch"]);
    expect(issueCodes({ ...deleted, reasonCode: null })).toEqual(["reason_mismatch"]);
    expect(issueCodes({ ...deleted, actor: participant })).toEqual(["reason_mismatch"]);
    expect(issueCodes({ ...deleted, actor: assisted })).toEqual([
      "actor_mismatch",
      "reason_mismatch",
    ]);
    for (const bad of [
      { ...added, details: { ...added.details, fileName: "Lebenslauf.pdf" } },
      { ...reviewed, actor: assisted },
      { ...rejected, reasonCode: "file_too_large" },
      { ...rejected, participationId: null },
    ]) {
      expect(AuditEvent.safeParse(bad).success).toBe(false);
    }
  });
});

describe("placement_agentur_set (Q139)", () => {
  const set = { ...base, type: "placement_agentur_set", actor: user };

  it("names the new and the replaced key and the base-defaults version", () => {
    for (const details of [
      { agenturKey: "nord", baseDefaultsVersion: 1 },
      { agenturKey: "sued", previousAgenturKey: "nord", baseDefaultsVersion: 1 },
    ]) {
      expect(issueCodes({ ...set, details })).toEqual([]);
    }
  });

  it("takes keys only, of a participation", () => {
    for (const details of [
      { agenturKey: "Agentur Nord", baseDefaultsVersion: 1 },
      { agenturKey: "nord", baseDefaultsVersion: 1, version: 2 },
    ]) {
      expect(AuditEvent.safeParse({ ...set, details }).success).toBe(false);
    }
    const ofProject = { ...set, participationId: null };
    expect(
      AuditEvent.safeParse({
        ...ofProject,
        details: { agenturKey: "nord", baseDefaultsVersion: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("self-service events (Q138, Q112)", () => {
  const participant = { type: "participant", participationId } as const;

  it("name the profile and custom fields a participant wrote, never a value", () => {
    const written = { ...base, type: "participant_data_changed", actor: participant };
    const fields = ["gender", "educationHistory", "mobile", "custom.beispiel_nr"];
    expect(issueCodes({ ...written, details: { fields } })).toEqual([]);
    for (const bad of [["nationality"], ["healthRestrictions"], ["custom.Nr"], ["gender", 1]]) {
      expect(AuditEvent.safeParse({ ...written, details: { fields: bad } }).success).toBe(false);
    }
  });

  it("record the purposes notice acknowledged, with version and language", () => {
    const acknowledged = {
      ...base,
      type: "self_service_notice_acknowledged",
      actor: participant,
      details: {
        acknowledgementId: otherId,
        noticeVersion: "self-service-purposes:v1",
        language: "en",
      },
    };
    expect(issueCodes(acknowledged)).toEqual([]);
    expect(
      AuditEvent.safeParse({ ...acknowledged, details: { ...acknowledged.details, text: "x" } })
        .success,
    ).toBe(false);
  });

  it("record a step-up by its method, never the date or the code (Q137)", () => {
    const stepUp = { ...base, actor: participant };
    for (const details of [
      { method: "birth_date" },
      { method: "photo_id_and_code", challengeId: otherId },
    ]) {
      expect(issueCodes({ ...stepUp, type: "step_up_completed", details })).toEqual([]);
    }
    expect(
      issueCodes({ ...stepUp, type: "step_up_failed", details: { method: "birth_date" } }),
    ).toEqual([]);
    for (const [type, details] of [
      ["step_up_completed", { method: "photo_id_and_code" }],
      ["step_up_completed", { method: "birth_date", birthDate: "1970-01-01" }],
      ["step_up_failed", { method: "photo_id_and_code" }],
    ] as const) {
      expect(AuditEvent.safeParse({ ...stepUp, type, details }).success).toBe(false);
    }
  });

  it("tie a consent's channel to the portal contact purpose", () => {
    const given = {
      ...base,
      type: "consent_given",
      actor: user,
      details: {
        consentId: otherId,
        purpose: "kug200b_profile_access",
        textVersion: "kug200b:v1",
        language: "de",
      },
    };
    expect(issueCodes(given)).toEqual([]);
    expect(issueCodes({ ...given, details: { ...given.details, channelId: otherId } })).toEqual([
      "channel_mismatch",
    ]);
    expect(
      issueCodes({
        ...given,
        type: "consent_ended",
        reasonCode: "revoked",
        details: { consentId: otherId, purpose: "portal_contact" },
      }),
    ).toEqual(["channel_mismatch"]);
  });
});

describe("the audit history's opening (data-protection.md, audit metadata; Q157)", () => {
  const opened = { ...base, type: "audit_history_opened", details: {} };

  it("records the viewer, the participation and the time only", () => {
    expect(issueCodes(opened)).toEqual([]);
    for (const bad of [
      { ...opened, details: { stream: "case" } },
      { ...opened, participationId: null },
      { ...opened, actor: { type: "system", job: "reminders.send" } },
      { ...opened, actor: { type: "participant", participationId } },
    ]) {
      expect(AuditEvent.safeParse(bad).success).toBe(false);
    }
  });
});

describe("appointments (data-protection.md, appointments; Q168)", () => {
  const participant = { type: "participant", participationId } as const;
  const terminal = { type: "system", job: "terminal-booking-cancellation" } as const;
  const startsAt = "2091-02-10T09:00:00.000Z";
  const ofProject = { ...base, participationId: null };
  const created = {
    ...ofProject,
    type: "appointment_created",
    details: {
      appointmentId: otherId,
      kind: "consultation",
      startsAt,
      endsAt: "2091-02-10T10:00:00.000Z",
      bookingClosesAt: "2091-02-09T09:00:00.000Z",
      capacity: 1,
      hostStaffUserId: staffUserId,
    },
  };
  const changed = {
    ...ofProject,
    type: "appointment_changed",
    details: { appointmentId: otherId, version: 2, fields: ["venue", "capacity"] },
  };
  const cancelled = {
    ...ofProject,
    type: "appointment_cancelled",
    reasonCode: "too_few_bookings",
    details: { appointmentId: otherId, correction: false },
  };
  const ofBooking = {
    bookingId: otherId,
    appointmentId: otherId,
    appointmentKind: "info_event",
    startsAt,
  };
  const booked = {
    ...base,
    type: "appointment_booked",
    details: { ...ofBooking, origin: "staff" },
  };
  const bookingCancelled = {
    ...base,
    type: "appointment_booking_cancelled",
    reasonCode: "staff_cancelled",
    details: ofBooking,
  };

  it("records the appointment's own events at project level, never its title or venue", () => {
    expect(issueCodes(created)).toEqual([]);
    expect(issueCodes(changed)).toEqual([]);
    expect(issueCodes(cancelled)).toEqual([]);
    for (const bad of [
      { ...created, details: { ...created.details, venue: "Kantine" } },
      { ...changed, details: { ...changed.details, title: "Info" } },
      { ...created, participationId },
      { ...cancelled, reasonCode: "free text" },
      { ...cancelled, actor: terminal },
    ]) {
      expect(AuditEvent.safeParse(bad).success).toBe(false);
    }
  });

  it("names a new host exactly when the host changed", () => {
    const host = { ...changed, details: { ...changed.details, fields: ["hostStaffUserId"] } };
    expect(issueCodes(host)).toEqual(["host_mismatch"]);
    expect(issueCodes({ ...host, details: { ...host.details, hostStaffUserId: otherId } })).toEqual(
      [],
    );
    expect(
      issueCodes({ ...changed, details: { ...changed.details, hostStaffUserId: otherId } }),
    ).toEqual(["host_mismatch"]);
  });

  it("records a booking with its appointment, kind and start as written, by its origin", () => {
    expect(issueCodes(booked)).toEqual([]);
    expect(
      issueCodes({
        ...booked,
        actor: participant,
        details: { ...ofBooking, origin: "participant" },
      }),
    ).toEqual([]);
    expect(issueCodes({ ...booked, actor: participant })).toEqual(["origin_mismatch"]);
    expect(issueCodes({ ...booked, details: { ...ofBooking, origin: "participant" } })).toEqual([
      "origin_mismatch",
    ]);
    expect(issueCodes({ ...booked, actor: terminal })).toEqual(["origin_mismatch"]);
    expect(issueCodes({ ...booked, actor: { ...user, onBehalfOf: participationId } })).toEqual([
      "origin_mismatch",
    ]);
    expect(AuditEvent.safeParse({ ...booked, participationId: null }).success).toBe(false);
  });

  it("ties a booking's cancellation reason to its actor", () => {
    expect(issueCodes(bookingCancelled)).toEqual([]);
    expect(issueCodes({ ...bookingCancelled, reasonCode: "appointment_cancelled" })).toEqual([]);
    expect(
      issueCodes({ ...bookingCancelled, actor: terminal, reasonCode: "participation_closed" }),
    ).toEqual([]);
    expect(
      issueCodes({ ...bookingCancelled, actor: participant, reasonCode: "participant_cancelled" }),
    ).toEqual([]);
    expect(issueCodes({ ...bookingCancelled, actor: terminal })).toEqual(["reason_mismatch"]);
    expect(issueCodes({ ...bookingCancelled, reasonCode: "participant_cancelled" })).toEqual([
      "reason_mismatch",
    ]);
    expect(
      issueCodes({ ...bookingCancelled, actor: { ...user, onBehalfOf: participationId } }),
    ).toEqual(["reason_mismatch"]);
  });
});
