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

describe("audit event types (plan 5.4)", () => {
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
    ]);
  });

  it("reserves the lifecycle and exception types for their own functions", () => {
    expect([...lifecycleEventTypes]).toEqual(AuditEventType.options.slice(0, 9));
  });

  it("reserves the setup types too (Slice 2, D2)", () => {
    expect([...setupEventTypes]).toEqual([
      "project_created",
      "project_changed",
      "entry_wave_created",
      "entry_wave_changed",
      "config_template_pinned",
    ]);
    expect([...reservedEventTypes]).toEqual([...lifecycleEventTypes, ...setupEventTypes]);
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

// R26 (round 23): this exact list; a type joins `configurationDependentEventTypes` with its PR.
const r26 = [
  "project_activated",
  "config_template_pinned",
  "config_override_changed",
  "rule_relaxation_requested",
  "rule_relaxation_approved",
  "import_confirmed",
];

describe("configuration-dependent events (R26, AC-45)", () => {
  it("are exactly the R26 types that exist so far", () => {
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

describe("actors (AC-18)", () => {
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

  it("carries the entry kind of a TG entry, and flags reconciliations (AC-18)", () => {
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
      { participationId: null, reasonCode: "relaxed", details: { baseDefaultsVersion: 1 } },
    ],
    ["review_recorded", { reasonCode: "no_concern", details: { reviewedEventId: otherId } }],
    ["clarification_requested", { details: { reviewedEventId: otherId } }],
    ["project_created", { participationId: null, details: { type: "ta_tg" } }],
    ["project_changed", { participationId: null, details: { fields: ["name", "customerName"] } }],
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
