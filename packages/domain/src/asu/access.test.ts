import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Actor, PermissionTarget } from "../access/permissions";
import { sample } from "../access/profiles";
import {
  mayAttestAsu,
  mayGenerateKug200bBulk,
  mayLinkAsuProof,
  mayReadKnowledgeDate,
  mayRecordAsu,
  maySetKnowledgeDate,
  mayViewAsu,
  mayRecordAsuConfirmation,
  mayWorkKug200b,
  mayWorkKug200bBatches,
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
const participant: Actor = {
  kind: "participant",
  participationId: sample.participationId,
  knowledgeCheckPassed: true,
};

describe("the ASU record's permissions (data-protection.md, the ASU record; Q201)", () => {
  it("is read by whoever reads the case data, as the matrix decides", () => {
    expect(mayViewAsu(unassigned, target)).toEqual({ ok: false, because: "not_assigned" });
    expect(mayViewAsu(participant, target).ok).toBe(false);
    for (const viewer of [pl, consultant, backOffice]) {
      expect(mayViewAsu(viewer, target).ok).toBe(true);
      expect(mayReadKnowledgeDate(viewer, target)).toBe(true);
    }
    for (const viewer of [unassigned, admin]) {
      expect(mayViewAsu(viewer, target).ok).toBe(false);
      expect(mayReadKnowledgeDate(viewer, target)).toBe(false);
    }
  });

  it.each([
    ["the route and a registration", mayRecordAsu, [pl, consultant]],
    ["the attestation", mayAttestAsu, [pl]],
    ["the proof's link", mayLinkAsuProof, [consultant]],
    ["the knowledge date", maySetKnowledgeDate, [pl]],
    ["the Kug 200b of one participation (Q179)", mayWorkKug200b, [pl, consultant]],
    ["the Kug 200b for 1–100 at once (Q179)", mayGenerateKug200bBulk, [pl]],
    ["Kug 200b batches (D25)", mayWorkKug200bBatches, [pl]],
    ["the Agentur's confirmation (D19)", mayRecordAsuConfirmation, [pl]],
  ] as const)("%s", (_, may, allowed) => {
    for (const actor of [pl, consultant, unassigned, backOffice, admin, participant]) {
      expect(may(actor, target).ok).toBe((allowed as readonly unknown[]).includes(actor));
    }
  });
});
