import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Actor, PermissionTarget } from "../access/permissions";
import { sample } from "../access/profiles";
import {
  mayReadUnemploymentPeriod,
  mayRecordProfiling,
  mayUseProfilingAssessment,
  mayViewProfiling,
  tl407ReadinessViewer,
} from "./access";

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

const pl = staff(["project_lead"]);
const consultant = staff(["consultant"], true);
const unassigned = staff(["consultant"]);
const backOffice = staff(["back_office"]);
const admin = staff([], false, "admin");
// Q61: a PL who is also a consultant, but not assigned to this participation
const plConsultant = staff(["project_lead", "consultant"]);
const participant: Actor = {
  kind: "participant",
  participationId: sample.participationId,
  knowledgeCheckPassed: true,
};

describe("the profiling record's permissions (data-protection.md, the profiling record)", () => {
  it("shows the tab to the PL and the assigned consultant, never back office (Q49, Q62)", () => {
    expect(mayViewProfiling(pl, target)).toEqual({ ok: true });
    expect(mayViewProfiling(consultant, target)).toEqual({ ok: true });
    expect(mayViewProfiling(unassigned, target)).toEqual({ ok: false, because: "not_assigned" });
    expect(mayViewProfiling(backOffice, target)).toEqual({
      ok: false,
      because: "role_not_allowed",
    });
    expect(mayViewProfiling(admin, target)).toEqual({ ok: false, because: "role_not_allowed" });
    expect(mayViewProfiling(participant, target).ok).toBe(false);
    expect(mayViewProfiling({ kind: "system" }, target).ok).toBe(false);
  });

  it("lets only the assigned consultant record sessions and declarations (Q193)", () => {
    expect(mayRecordProfiling(consultant, target)).toEqual({ ok: true });
    expect(mayRecordProfiling(pl, target)).toEqual({ ok: false, because: "role_not_allowed" });
    expect(mayRecordProfiling(plConsultant, target)).toEqual({
      ok: false,
      because: "not_assigned",
    });
    expect(mayRecordProfiling(backOffice, target).ok).toBe(false);
    expect(mayRecordProfiling(participant, target).ok).toBe(false);
  });

  it("gives section C to the assigned consultant only, also as PL and consultant (Q49, Q61)", () => {
    for (const action of ["read", "write"] as const) {
      expect(mayUseProfilingAssessment(consultant, target, action)).toBe(true);
      for (const other of [pl, unassigned, backOffice, admin, plConsultant]) {
        expect(mayUseProfilingAssessment(other, target, action)).toBe(false);
      }
    }
  });

  it("lets the assigned consultant and back office read the unemployment period, never the PL", () => {
    expect(mayReadUnemploymentPeriod(consultant, target)).toBe(true);
    expect(mayReadUnemploymentPeriod(backOffice, target)).toBe(true);
    for (const other of [pl, unassigned, admin]) {
      expect(mayReadUnemploymentPeriod(other, target)).toBe(false);
    }
  });

  it("projects the TL 407 readiness for the profiler and the PL, nobody else", () => {
    expect(tl407ReadinessViewer(consultant, target)).toBe("profiler");
    expect(tl407ReadinessViewer(staff(["project_lead", "consultant"], true), target)).toBe(
      "profiler",
    );
    expect(tl407ReadinessViewer(pl, target)).toBe("project_lead");
    expect(tl407ReadinessViewer(plConsultant, target)).toBe("project_lead");
    for (const other of [unassigned, backOffice, admin, participant]) {
      expect(tl407ReadinessViewer(other, target)).toBeNull();
    }
  });
});
