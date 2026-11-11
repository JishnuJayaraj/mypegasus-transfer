import { describe, expect, it } from "vitest";
import { sample } from "../access/profiles";
import type { PermissionTarget } from "../access/permissions";
import type { ProjectRole } from "../enums";
import {
  credentialCutoff,
  mayReadFunding,
  mayRecordFunding,
  RetentionClass,
  retentionActivation,
  retentionDue,
  retentionRules,
  settlementDatesRequired,
  workingCopyTriggers,
  type RetentionPeriods,
} from "./rules";

// Synthetic periods: test values, never the DPO's (Q3, Q24).
const unset = Object.fromEntries(
  RetentionClass.options.map((c) => [c, "unset"]),
) as RetentionPeriods;
const synthetic: RetentionPeriods = {
  ...unset,
  reference_data: "never",
  access_credential: { days: { ended: 30 } },
  form_working_copy: {
    days: { superseded: 30, scan_accepted: 30, abandoned: 90, participation_closed: 30 },
  },
};

describe("retentionDue (ADR-0008; data-protection.md, retention)", () => {
  const credential = (ended: string | null, held = false) => ({
    class: "access_credential" as const,
    triggers: { ended },
    held,
  });

  it("keeps a credential for 30 days and deletes it on day 31", () => {
    expect(retentionDue(credential("2026-01-01"), synthetic, "2026-01-31")).toEqual({
      kind: "not_due",
      on: "2026-02-01",
    });
    expect(retentionDue(credential("2026-01-01"), synthetic, "2026-02-01")).toEqual({
      kind: "due",
      stage: 1,
      trigger: "ended",
      from: "2026-01-01",
    });
  });

  it("deletes nothing while the period is unset, never or without a trigger's days", () => {
    expect(retentionDue(credential("2020-01-01"), unset, "2026-02-01")).toEqual({
      kind: "period_unset",
    });
    expect(
      retentionDue({ class: "reference_data", triggers: {}, held: false }, synthetic, "2026-02-01"),
    ).toEqual({ kind: "never" });
    const partial: RetentionPeriods = { ...synthetic, access_credential: { days: {} } };
    expect(retentionDue(credential("2020-01-01"), partial, "2026-02-01")).toEqual({
      kind: "period_unset",
    });
  });

  it("holds an item, and waits for a trigger that hasn't happened", () => {
    expect(retentionDue(credential("2020-01-01", true), synthetic, "2026-02-01")).toEqual({
      kind: "held",
    });
    expect(retentionDue(credential(null), synthetic, "2026-02-01")).toEqual({
      kind: "not_due",
      on: null,
    });
  });

  it("takes a working copy's earliest trigger (Q179)", () => {
    const due = (facts: Parameters<typeof workingCopyTriggers>[0], today: string) =>
      retentionDue(
        { class: "form_working_copy", triggers: workingCopyTriggers(facts), held: false },
        synthetic,
        today,
      );
    const abandoned = {
      generatedOn: "2026-01-01",
      supersededOn: null,
      scanAcceptedOn: null,
      closedOn: null,
    };
    expect(due(abandoned, "2026-04-01")).toEqual({ kind: "not_due", on: "2026-04-02" });
    expect(due(abandoned, "2026-04-02")).toMatchObject({ kind: "due", trigger: "abandoned" });
    // An accepted scan on day 80 ends the abandonment: day 111, not day 91.
    const scanned = { ...abandoned, scanAcceptedOn: "2026-03-22" };
    expect(due(scanned, "2026-04-02")).toEqual({ kind: "not_due", on: "2026-04-22" });
    expect(due({ ...scanned, closedOn: "2026-03-01" }, "2026-04-01")).toEqual({
      kind: "due",
      stage: 1,
      trigger: "participation_closed",
      from: "2026-03-01",
    });
    expect(due({ ...abandoned, supersededOn: "2026-01-10" }, "2026-02-10")).toMatchObject({
      kind: "due",
      trigger: "superseded",
    });
  });

  it("applies only the credentials and working copies; the rest is reported", () => {
    expect(RetentionClass.options.filter((c) => retentionRules[c].applied)).toEqual([
      "access_credential",
      "form_working_copy",
      "orphaned_object",
    ]);
  });
});

describe("credentialCutoff", () => {
  it("is the last ended day due today, or null without a period", () => {
    expect(credentialCutoff(synthetic, "2026-02-01")).toBe("2026-01-01");
    expect(credentialCutoff(unset, "2026-02-01")).toBeNull();
    expect(credentialCutoff({ ...unset, access_credential: "never" }, "2026-02-01")).toBeNull();
    expect(
      credentialCutoff({ ...unset, access_credential: { days: {} } }, "2026-02-01"),
    ).toBeNull();
  });
});

describe("retentionActivation (Q219)", () => {
  const all = {
    periods_confirmed: true,
    hold_administration_confirmed: true,
    evidence_only_access_built: true,
    maintenance_rules_complete: true,
  };

  it("is active only with every prerequisite met", () => {
    expect(retentionActivation(all)).toEqual({ active: true, unmet: [] });
    expect(retentionActivation({ ...all, evidence_only_access_built: false })).toEqual({
      active: false,
      unmet: ["evidence_only_access_built"],
    });
  });
});

describe("settlementDatesRequired (Q52, Q217)", () => {
  it("asks only for the dates that apply, and flags unknown funding", () => {
    expect(settlementDatesRequired({ anyEnteredTg: false, fundings: ["known_no"] })).toEqual({
      kugFinalSettlementDate: false,
      measure110SettlementDate: false,
      fundingUnknown: false,
    });
    expect(
      settlementDatesRequired({ anyEnteredTg: true, fundings: ["known_yes", "unknown"] }),
    ).toEqual({
      kugFinalSettlementDate: true,
      measure110SettlementDate: true,
      fundingUnknown: true,
    });
  });
});

describe("mayRecordFunding", () => {
  const target: PermissionTarget = {
    projectId: sample.projectId,
    regionId: sample.regionId,
    participationId: null,
  };
  const staff = (roles: ProjectRole[]) =>
    ({
      kind: "staff",
      staffUserId: "staff-a",
      orgRoles: new Map(),
      projectRoles: { [sample.projectId]: new Set(roles) },
      assignedParticipationIds: new Set<string>(),
    }) as const;

  it("lets back office record, never the PL, a consultant or the participant", () => {
    expect(mayRecordFunding(staff(["back_office"]), target).ok).toBe(true);
    expect(mayRecordFunding(staff(["project_lead"]), target).ok).toBe(false);
    expect(mayRecordFunding(staff(["consultant"]), target).ok).toBe(false);
    expect(mayReadFunding(staff(["project_lead"]), target).ok).toBe(true);
    expect(mayReadFunding(staff(["back_office"]), target).ok).toBe(true);
    expect(mayReadFunding(staff(["consultant"]), target).ok).toBe(false);
    expect(
      mayReadFunding(
        { kind: "participant", participationId: "p", knowledgeCheckPassed: true },
        target,
      ).ok,
    ).toBe(false);
    expect(
      mayRecordFunding(
        {
          kind: "participant",
          participationId: sample.participationId,
          knowledgeCheckPassed: true,
        },
        target,
      ).ok,
    ).toBe(false);
  });
});
