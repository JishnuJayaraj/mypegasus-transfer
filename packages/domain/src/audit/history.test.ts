import { describe, expect, it } from "vitest";
import type { Subject } from "../access/decide";
import { ProjectRole } from "../enums";
import { fieldCatalog } from "../fields/catalog";
import { AuditEvent, AuditEventType, StatusField } from "./events";
import {
  auditProjection,
  auditProjectionRows,
  fieldCategoryRows,
  historyEventTypes,
  historyStreams,
  historyStreamsOf,
  projectionOf,
  roleFieldKnowledge,
  roleFieldKnowledgeRows,
} from "./history";

const projectId = "00000000-0000-4000-9000-000000000001";
const participationId = "00000000-0000-4000-a000-000000000001";
const viewer = "00000000-0000-4000-8000-000000000003";

/** The keys an event type's `details` schema has (a union's options together). */
function detailKeysOf(type: AuditEventType): string[] {
  const option = AuditEvent.options.find((o) => o.shape.type.value === type)!;
  const details = option.shape.details as unknown as {
    shape?: Record<string, unknown>;
    options?: { shape: Record<string, unknown> }[];
  };
  const shapes = details.options?.map((o) => o.shape) ?? [details.shape!];
  return [...new Set(shapes.flatMap((shape) => Object.keys(shape)))];
}

describe("auditProjection (data-protection.md, audit metadata; Q157)", () => {
  it("has a row for every event type, and one per status field for status_changed", () => {
    expect(Object.keys(auditProjection).toSorted()).toEqual(AuditEventType.options.toSorted());
    expect(Object.keys(auditProjection.status_changed).toSorted()).toEqual(
      StatusField.options.toSorted(),
    );
    const rows = auditProjectionRows();
    expect(rows).toHaveLength(AuditEventType.options.length - 1 + StatusField.options.length);
    expect(new Set(rows.map((row) => `${row.eventType}/${row.field}`)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.field === null).toBe(row.eventType !== "status_changed");
    }
  });

  it("puts each status field in its track's stream", () => {
    expect(projectionOf("status_changed", "status").stream).toBe("case");
    expect(projectionOf("status_changed", "profiling_status").stream).toBe("profiling");
    expect(projectionOf("status_changed", "dsv_status").stream).toBe("dsv");
    expect(() => projectionOf("status_changed", null)).toThrow("status_changed needs its field");
    expect(projectionOf("entry_wave_assigned", null)).toBe(auditProjection.entry_wave_assigned);
  });

  it("never shows logins, codes, step-ups, sensitive access, openings, break-glass, exports or sessions", () => {
    for (const type of [
      "participant_login",
      "participant_logout",
      "one_time_code_exhausted",
      "activation_code_locked",
      "contact_channels_suspended",
      "step_up_completed",
      "step_up_failed",
      "sensitive_read",
      "sensitive_write",
      "document_opened",
      "document_upload_rejected",
      "break_glass_access",
      "export_created",
      "assisted_mode_started",
      "assisted_mode_ended",
      "audit_history_opened",
    ] as const) {
      expect(auditProjection[type].stream).toBe("security");
    }
    expect(auditProjection.review_recorded.stream).toBe("review");
    expect(auditProjection.clarification_requested.stream).toBe("review");
  });

  it("gives project-level events no stream: they are in no participation's history", () => {
    const projectLevel = auditProjectionRows()
      .filter((row) => row.stream === null)
      .map((row) => row.eventType);
    expect(projectLevel.toSorted()).toEqual(
      [
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
        "import_confirmed",
        "project_member_added",
        "project_member_removed",
        "appointment_created",
        "appointment_changed",
        "appointment_cancelled",
      ].toSorted(),
    );
    for (const type of projectLevel) {
      const option = AuditEvent.options.find((o) => o.shape.type.value === type)!;
      expect(option.shape.participationId.safeParse(null).success).toBe(true);
    }
  });

  it("shows nothing of an event outside the history's streams", () => {
    const outside = auditProjectionRows().filter(
      (row) => row.stream === null || row.stream === "security" || row.stream === "review",
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const row of outside) {
      expect(row).toMatchObject({ showsChange: false, showsReason: false, detailKeys: [] });
    }
  });

  it("allows only detail keys the event type has, never an id of evidence or a version of rules", () => {
    for (const row of auditProjectionRows()) {
      const keys = detailKeysOf(row.eventType);
      for (const key of row.detailKeys) expect(keys).toContain(key);
      for (const key of ["evidenceRecordId", "baseDefaultsVersion", "scheduledAt", "amendmentId"]) {
        expect(row.detailKeys).not.toContain(key);
      }
    }
  });

  it("holds field keys only in the `fields` detail of a person-data or declarations change", () => {
    const withFields = auditProjectionRows().filter((row) => row.detailKeys.includes("fields"));
    expect(withFields.map((row) => row.eventType)).toEqual([
      "participant_data_changed",
      "profiling_declarations_recorded",
    ]);
  });

  it("shows a change only where the event has one", () => {
    const withChange = auditProjectionRows()
      .filter((row) => row.showsChange)
      .map((row) => `${row.eventType}/${row.field}`);
    expect(withChange).toEqual([
      "participation_created/null",
      "status_changed/status",
      "status_changed/profiling_status",
      "status_changed/dsv_status",
      "end_reason_corrected/null",
    ]);
  });

  it("lists the types a history can show", () => {
    expect(historyEventTypes).toContain("status_changed");
    expect(historyEventTypes).toContain("entry_wave_assigned");
    expect(historyEventTypes).toContain("reminder_queued");
    expect(historyEventTypes).toContain("participation_dates_changed");
    expect(historyEventTypes).not.toContain("document_opened");
    expect(historyEventTypes).not.toContain("audit_history_opened");
    expect(historyEventTypes).not.toContain("project_created");
    expect(historyEventTypes).not.toContain("review_recorded");
  });
});

const streams = (roles: ProjectRole[], assigned = true) => historyStreams(new Set(roles), assigned);

describe("historyStreams (Q157)", () => {
  it("gives each project role its streams, the consultant only while assigned", () => {
    expect(streams(["project_lead"])).toEqual({
      streams: ["case", "profiling", "dsv"],
      ownStreams: [],
    });
    expect(streams(["consultant"])).toEqual({
      streams: ["case", "profiling"],
      ownStreams: ["dsv", "payroll"],
    });
    expect(streams(["consultant"], false)).toEqual({ streams: [], ownStreams: [] });
    expect(streams(["back_office"], false)).toEqual({
      streams: ["dsv", "payroll"],
      ownStreams: [],
    });
    expect(streams([])).toEqual({ streams: [], ownStreams: [] });
  });

  it("is the union of the viewer's roles (Q61)", () => {
    expect(streams(["consultant", "back_office"])).toEqual({
      streams: ["case", "profiling", "dsv", "payroll"],
      ownStreams: [],
    });
    expect(streams(["project_lead", "consultant"])).toEqual({
      streams: ["case", "profiling", "dsv"],
      ownStreams: ["payroll"],
    });
    expect(streams(["project_lead", "consultant"], false)).toEqual({
      streams: ["case", "profiling", "dsv"],
      ownStreams: [],
    });
  });

  it("takes the roles of the participation's project from a subject; org roles and participants get none", () => {
    const staff = (projectRoles: ProjectRole[], assigned: string[] = []): Subject => ({
      kind: "staff",
      staffUserId: viewer,
      orgRoles: new Map([["admin", { regionIds: "all" }]]),
      projectRoles: { [projectId]: new Set(projectRoles) },
      assignedParticipationIds: new Set(assigned),
    });
    const target = { projectId, participationId };
    expect(historyStreamsOf(staff(["consultant"], [participationId]), target)).toEqual(
      streams(["consultant"]),
    );
    expect(historyStreamsOf(staff(["consultant"]), target)).toEqual(streams([]));
    expect(historyStreamsOf(staff([]), target)).toEqual(streams([]));
    expect(
      historyStreamsOf(staff(["project_lead"]), { ...target, projectId: participationId }),
    ).toEqual(streams([]));
    expect(
      historyStreamsOf(
        { kind: "participant", participationId, knowledgeCheckPassed: true },
        target,
      ),
    ).toEqual(streams([]));
  });
});

describe("roleFieldKnowledge (data-protection.md, access matrix)", () => {
  it("is what each project role may know of a field in normal or assisted mode", () => {
    expect(roleFieldKnowledge).toEqual({
      project_lead: ["case_internal", "confidential", "health", "disability", "absence"],
      consultant: [
        "case_internal",
        "confidential",
        "health",
        "disability",
        "identifiers",
        "residence_social",
        "profiling_assessment",
        "absence",
      ],
      back_office: [
        "case_internal",
        "confidential",
        "disability",
        "identifiers",
        "residence_social",
        "absence",
      ],
    });
    expect(roleFieldKnowledgeRows()).toHaveLength(
      ProjectRole.options.reduce((n, role) => n + roleFieldKnowledge[role].length, 0),
    );
    expect(roleFieldKnowledgeRows()[0]).toEqual({
      projectRole: "project_lead",
      accessCategory: "case_internal",
    });
  });

  it("knows each catalog field's category, and a custom field as confidential", () => {
    const rows = fieldCategoryRows();
    expect(rows).toHaveLength(fieldCatalog.length + 1);
    expect(rows).toContainEqual({ fieldKey: "healthRestrictions", accessCategory: "health" });
    expect(rows).toContainEqual({ fieldKey: "personnelNumber", accessCategory: "confidential" });
    expect(rows.at(-1)).toEqual({ fieldKey: "custom.*", accessCategory: "confidential" });
  });
});
