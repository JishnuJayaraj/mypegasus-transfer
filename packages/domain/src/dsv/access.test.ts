import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Actor, PermissionTarget } from "../access/permissions";
import { sample } from "../access/profiles";
import { mayPinDsvTemplate, mayWorkDsv } from "./access";

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

describe("the DSV's permissions (data-protection.md, employment_contract; Q60)", () => {
  it("lets the PL and back office work the DSV, never a consultant, an org role or the participant", () => {
    expect(mayWorkDsv(staff(["project_lead"]), target).ok).toBe(true);
    expect(mayWorkDsv(staff(["back_office"]), target).ok).toBe(true);
    expect(mayWorkDsv(staff(["consultant"], true), target).ok).toBe(false);
    expect(mayWorkDsv(staff([], false, "admin"), target).ok).toBe(false);
    expect(mayWorkDsv(participant, target)).toEqual({ ok: false, because: "actor_not_allowed" });
  });

  it("lets only the PL pin the template", () => {
    expect(mayPinDsvTemplate(staff(["project_lead"]), target).ok).toBe(true);
    expect(mayPinDsvTemplate(staff(["back_office"]), target).ok).toBe(false);
    expect(mayPinDsvTemplate(participant, target).ok).toBe(false);
  });
});
