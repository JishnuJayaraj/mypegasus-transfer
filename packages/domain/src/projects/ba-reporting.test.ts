import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Actor, PermissionTarget } from "../access/permissions";
import { sample } from "../access/profiles";
import { BaReportInput, mayRecordBaReport } from "./ba-reporting";

const target: PermissionTarget = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};

function staff(projectRoles: ProjectRole[], assigned = false, org?: OrgRole) {
  return {
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(org ? [[org, { regionIds: "all" as const }]] : []),
    projectRoles: { [sample.projectId]: new Set(projectRoles) },
    assignedParticipationIds: new Set(assigned ? [sample.participationId] : []),
  } as const;
}

const participant: Actor = {
  kind: "participant",
  participationId: sample.participationId,
  knowledgeCheckPassed: true,
};

describe("mayRecordBaReport (process-and-lifecycle.md, BA reporting; D28)", () => {
  it("is the PL's and back office's of the project", () => {
    expect(mayRecordBaReport(staff(["project_lead"]), target).ok).toBe(true);
    expect(mayRecordBaReport(staff(["back_office"]), target).ok).toBe(true);
  });

  it("is never a consultant's, assigned or not, an admin's, another project's or a participant's", () => {
    for (const actor of [
      staff(["consultant"], true),
      staff(["consultant"]),
      staff([], false, "admin"),
      staff([], false, "regional_operations_manager"),
      { ...staff(["project_lead"]), projectRoles: { other: new Set(["project_lead"] as const) } },
      participant,
    ]) {
      expect(mayRecordBaReport(actor, target).ok).toBe(false);
    }
  });
});

describe("BaReportInput (D28)", () => {
  it("takes the sent date for reported and a closed reason for not_required", () => {
    expect(BaReportInput.parse({ outcome: "reported", reportedOn: "2026-11-02" })).toEqual({
      outcome: "reported",
      reportedOn: "2026-11-02",
    });
    for (const reason of [
      "agentur_confirmed_not_required",
      "no_claim_month_affected",
      "created_in_error",
    ]) {
      expect(BaReportInput.safeParse({ outcome: "not_required", reason }).success).toBe(true);
    }
  });

  it("refuses a missing or impossible date, another reason, a mix and free text", () => {
    for (const input of [
      { outcome: "reported" },
      { outcome: "reported", reportedOn: "2026-02-30" },
      { outcome: "reported", reportedOn: "2026-11-02", reason: "created_in_error" },
      { outcome: "not_required" },
      { outcome: "not_required", reason: "other" },
      { outcome: "not_required", reason: "created_in_error", reportedOn: "2026-11-02" },
      { outcome: "not_required", reason: "created_in_error", note: "x" },
      { outcome: "pending" },
    ]) {
      expect(BaReportInput.safeParse(input).success).toBe(false);
    }
  });
});
