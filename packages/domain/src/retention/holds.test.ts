import { describe, expect, it } from "vitest";
import { sample } from "../access/profiles";
import type { PermissionTarget } from "../access/permissions";
import type { ProjectRole } from "../enums";
import {
  holdScopeProblem,
  LegalHoldRelease,
  mayPlaceLegalHold,
  mayReleaseLegalHold,
} from "./holds";

const target: PermissionTarget = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const staff = (roles: ProjectRole[], manager?: string[]) =>
  ({
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(
      manager ? [["regional_operations_manager" as const, { regionIds: new Set(manager) }]] : [],
    ),
    projectRoles: { [sample.projectId]: new Set(roles) },
    assignedParticipationIds: new Set<string>(),
  }) as const;

describe("holdScopeProblem (Q218)", () => {
  it("refuses an empty scope and the whole participation", () => {
    expect(holdScopeProblem({ classes: [], recordKinds: [], documentIds: [] })).toBe(
      "hold_scope_empty",
    );
    expect(
      holdScopeProblem({
        classes: ["personnel_file", "health_record", "form_working_copy", "evidence_set"],
        recordKinds: [],
        documentIds: [],
      }),
    ).toBe("hold_scope_too_broad");
    expect(
      holdScopeProblem({
        classes: ["health_record"],
        recordKinds: ["dsv_contract"],
        documentIds: [],
      }),
    ).toBeNull();
    expect(holdScopeProblem({ classes: [], recordKinds: [], documentIds: ["d"] })).toBeNull();
  });
});

describe("legal hold permissions", () => {
  it("lets the PL and back office place, never a consultant or a manager", () => {
    expect(mayPlaceLegalHold(staff(["project_lead"]), target).ok).toBe(true);
    expect(mayPlaceLegalHold(staff(["back_office"]), target).ok).toBe(true);
    expect(mayPlaceLegalHold(staff(["consultant"]), target).ok).toBe(false);
    expect(mayPlaceLegalHold(staff([], [sample.regionId]), target).ok).toBe(false);
    expect(
      mayPlaceLegalHold(
        { kind: "participant", participationId: "p", knowledgeCheckPassed: true },
        target,
      ).ok,
    ).toBe(false);
  });

  it("lets another regional manager of the region release, not the placer or a PL", () => {
    expect(mayReleaseLegalHold(staff([], [sample.regionId]), target, "staff-b").ok).toBe(true);
    expect(mayReleaseLegalHold(staff([], [sample.regionId]), target, "staff-a")).toEqual({
      ok: false,
      because: "four_eyes",
    });
    expect(mayReleaseLegalHold(staff([], ["other-region"]), target, "staff-b").ok).toBe(false);
    expect(mayReleaseLegalHold(staff(["project_lead"]), target, "staff-b").ok).toBe(false);
    expect(
      mayReleaseLegalHold(
        { kind: "participant", participationId: "p", knowledgeCheckPassed: true },
        target,
        "x",
      ).ok,
    ).toBe(false);
  });
});

describe("the documented source", () => {
  it("is one trimmed line without control characters", () => {
    expect(LegalHoldRelease.safeParse({ source: "Weisung DSB" }).success).toBe(true);
    expect(LegalHoldRelease.safeParse({ source: " Weisung" }).success).toBe(false);
    expect(LegalHoldRelease.safeParse({ source: "Weisung\nDSB" }).success).toBe(false);
  });
});
