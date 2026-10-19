import { describe, expect, it } from "vitest";
import type { OrgRole, ProjectRole } from "../enums";
import type { Subject } from "./decide";
import {
  participationDetail,
  participationListScope,
  type ParticipationRecord,
} from "./participation-view";

// Slice 2 plan, "Planned in PR 2h" (R29, R30; AC-34, AC-49): who lists which participations of
// a project, and what the detail of one participation shows.

const projectId = "project-a";
const otherProject = "project-b";

function staff(
  projectRoles: Record<string, ProjectRole[]>,
  options: { org?: OrgRole[]; assigned?: string[] } = {},
): Subject {
  return {
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map((options.org ?? []).map((role) => [role, { regionIds: "all" }])),
    projectRoles: Object.fromEntries(
      Object.entries(projectRoles).map(([id, roles]) => [id, new Set(roles)]),
    ),
    assignedParticipationIds: new Set(options.assigned ?? []),
  };
}

describe("participationListScope (R29, AC-49)", () => {
  it("lets the PL and back office list every participation of their project", () => {
    expect(participationListScope(staff({ [projectId]: ["project_lead"] }), projectId)).toEqual({
      kind: "all",
    });
    expect(participationListScope(staff({ [projectId]: ["back_office"] }), projectId)).toEqual({
      kind: "all",
    });
  });

  it("lists exactly the assigned participations for a consultant", () => {
    const consultant = staff({ [projectId]: ["consultant"] }, { assigned: ["p-1", "p-2"] });
    expect(participationListScope(consultant, projectId)).toEqual({
      kind: "assigned",
      participationIds: ["p-1", "p-2"],
    });
  });

  it("gives a consultant without assignments, or not in the project, nothing", () => {
    expect(participationListScope(staff({ [projectId]: ["consultant"] }), projectId)).toEqual({
      kind: "none",
    });
    const elsewhere = staff({ [otherProject]: ["consultant"] }, { assigned: ["p-1"] });
    expect(participationListScope(elsewhere, projectId)).toEqual({ kind: "none" });
  });

  it("takes the most permissive of several roles (D6)", () => {
    const both = staff({ [projectId]: ["consultant", "back_office"] }, { assigned: ["p-1"] });
    expect(participationListScope(both, projectId)).toEqual({ kind: "all" });
  });

  it("gives org roles and participants no participant list", () => {
    for (const org of ["admin", "regional_admin", "regional_operations_manager"] as const) {
      expect(participationListScope(staff({}, { org: [org] }), projectId)).toEqual({
        kind: "none",
      });
    }
    const participant: Subject = {
      kind: "participant",
      participationId: "p-1",
      knowledgeCheckPassed: true,
    };
    expect(participationListScope(participant, projectId)).toEqual({ kind: "none" });
  });
});

const record: ParticipationRecord = {
  id: "p-1",
  projectId,
  status: "informed",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 3,
  wave: {
    id: "wave-1",
    code: "W1",
    name: "Welle 1",
    signingDeadline: "2027-03-15",
    defaultTgStart: "2027-04-01",
    defaultTgEnd: "2028-03-31",
    latestEntryDate: "2027-04-30",
  },
  dates: {
    tgStart: null,
    tgEnd: "2028-02-29",
    offerDeadline: null,
    tgEntryDate: null,
    exitDate: null,
    withdrawnOn: null,
    profilingDoneOn: null,
  },
  person: {
    personnelNumber: "BSP-0001",
    lastName: "Mustermann",
    firstName: "Erika",
    birthDate: "1970-01-01",
    oldEmploymentEndDate: "2027-03-31",
    address: {
      street: "Musterstraße 1",
      postalCode: "99999",
      city: "Beispielstadt",
      country: "DE",
    },
    phone: null,
    mobile: "0171 3920000",
    privateEmail: "erika@example.org",
    workEmail: null,
  },
};
const options = { today: "2027-03-01", capabilities: { assignEntryWave: true } } as const;

describe("participationDetail (R30, AC-34)", () => {
  it("shows the PL the case data, the effective dates and every person field", () => {
    const detail = participationDetail(staff({ [projectId]: ["project_lead"] }), record, options);
    expect(detail).toEqual({
      id: "p-1",
      projectId,
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
      statusVersion: 3,
      entryWave: record.wave,
      dates: {
        ...record.dates,
        effectiveTgStart: "2027-04-01",
        effectiveTgEnd: "2028-02-29",
      },
      hints: [],
      person: record.person,
      capabilities: { assignEntryWave: true },
    });
  });

  it("keeps an unrecorded value as null for back office too", () => {
    const detail = participationDetail(staff({ [projectId]: ["back_office"] }), record, options);
    expect(detail?.person.phone).toBeNull();
    expect(detail?.person.address).toEqual(record.person.address);
  });

  it("shows an assigned consultant the participation, an unassigned one nothing", () => {
    const assigned = staff({ [projectId]: ["consultant"] }, { assigned: ["p-1"] });
    expect(participationDetail(assigned, record, options)?.person).toEqual(record.person);
    expect(participationDetail(staff({ [projectId]: ["consultant"] }), record, options)).toBeNull();
  });

  it("shows org roles and non-members nothing", () => {
    expect(participationDetail(staff({}, { org: ["admin"] }), record, options)).toBeNull();
    expect(participationDetail(staff({ [otherProject]: ["project_lead"] }), record, options)).toBe(
      null,
    );
  });

  it("derives the missed TG start for an informed participation, never stored", () => {
    const pl = staff({ [projectId]: ["project_lead"] });
    const late = { ...options, today: "2027-04-02" };
    expect(participationDetail(pl, record, late)?.hints).toEqual(["tg_start_missed"]);
    expect(participationDetail(pl, record, { ...options, today: "2027-04-01" })?.hints).toEqual([]);
    const entered = { ...record, status: "active_in_tg" as const };
    expect(participationDetail(pl, entered, late)?.hints).toEqual([]);
    const noWave = { ...record, wave: null };
    expect(participationDetail(pl, noWave, late)).toMatchObject({
      entryWave: null,
      hints: [],
      dates: { effectiveTgStart: null, effectiveTgEnd: "2028-02-29" },
    });
  });
});
