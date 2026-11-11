import { describe, expect, it } from "vitest";
import { sample } from "../access/profiles";
import type { PermissionTarget } from "../access/permissions";
import type { ProjectRole } from "../enums";
import {
  credentialCutoff,
  evidenceOnlyApplies,
  participationRetentionTriggers,
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

const credential = (ended: string | null, held = false) => ({
  class: "access_credential" as const,
  triggers: { ended },
  held,
});

const due = (facts: Parameters<typeof workingCopyTriggers>[0], today: string) =>
  retentionDue(
    { class: "form_working_copy", triggers: workingCopyTriggers(facts), held: false },
    synthetic,
    today,
  );

const staff = (roles: ProjectRole[]) =>
  ({
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(),
    projectRoles: { [sample.projectId]: new Set(roles) },
    assignedParticipationIds: new Set<string>(),
  }) as const;

describe("retentionDue (ADR-0008; data-protection.md, retention)", () => {
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
    // A later trigger never postpones an earlier one.
    expect(
      due({ ...abandoned, supersededOn: "2026-01-10", closedOn: "2026-01-20" }, "2026-02-10"),
    ).toMatchObject({ kind: "due", trigger: "superseded" });
    expect(due({ ...abandoned, supersededOn: "2026-01-10" }, "2026-02-10")).toMatchObject({
      kind: "due",
      trigger: "superseded",
    });
  });

  it("applies only the credentials and working copies; the rest is reported", () => {
    expect(RetentionClass.options.filter((c) => retentionRules[c].applied)).toEqual([
      "personnel_file",
      "health_record",
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

// Synthetic per-class periods (test values only): 90 days for a non-signer, 3 months for health
// after exit, the end of the 3rd calendar year after exit or closure.
const perClass: RetentionPeriods = {
  ...synthetic,
  personnel_file: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
  health_record: {
    days: { non_signer_withdrawn: 90 },
    months: { closed_without_tg: 3, exited: 3 },
  },
  participation_record: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
};

const item = (c: "personnel_file" | "health_record", triggers: Record<string, string | null>) => ({
  class: c,
  triggers,
  held: false,
});

describe("retention per class (data-protection.md, retention per class)", () => {
  const nonSigner = participationRetentionTriggers({
    status: "withdrawn",
    closedOn: "2026-03-02",
    withdrawnOn: "2026-03-01",
    enteredTg: false,
    dsvFullyExecuted: false,
  });

  it("deletes a non-signer's personnel file on day 91, not 90", () => {
    expect(nonSigner).toEqual({
      non_signer_withdrawn: "2026-03-01",
      closed_without_tg: null,
      exited: null,
    });
    expect(retentionDue(item("personnel_file", nonSigner), perClass, "2026-05-30").kind).toBe(
      "not_due",
    );
    expect(retentionDue(item("personnel_file", nonSigner), perClass, "2026-05-31")).toEqual({
      kind: "due",
      stage: 1,
      trigger: "non_signer_withdrawn",
      from: "2026-03-01",
    });
  });

  it("deletes the health record 3 months after exit while the personnel file stays", () => {
    const exited = participationRetentionTriggers({
      status: "exited",
      closedOn: "2026-06-30",
      withdrawnOn: null,
      enteredTg: true,
      dsvFullyExecuted: true,
    });
    expect(retentionDue(item("health_record", exited), perClass, "2026-09-30").kind).toBe(
      "not_due",
    );
    expect(retentionDue(item("health_record", exited), perClass, "2026-10-01").kind).toBe("due");
    expect(retentionDue(item("personnel_file", exited), perClass, "2026-10-01")).toEqual({
      kind: "not_due",
      on: "2030-01-01",
    });
    expect(retentionDue(item("personnel_file", exited), perClass, "2030-01-01").kind).toBe("due");
  });

  it("closes a signer without TG entry, or ta_completed, at its own trigger", () => {
    const facts = { closedOn: "2026-04-02", withdrawnOn: "2026-04-01", enteredTg: false } as const;
    expect(
      participationRetentionTriggers({ ...facts, status: "withdrawn", dsvFullyExecuted: true }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: "2026-04-01", exited: null });
    expect(
      participationRetentionTriggers({
        ...facts,
        withdrawnOn: null,
        status: "ta_completed",
        dsvFullyExecuted: false,
      }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: "2026-04-02", exited: null });
    expect(
      participationRetentionTriggers({ ...facts, status: "informed", dsvFullyExecuted: false }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: null, exited: null });
  });

  it("blocks the participation record of a non-entrant while the funding is unknown", () => {
    const record = (funded110: "unknown" | "known_no", enteredTg = false) => ({
      class: "participation_record" as const,
      triggers: nonSigner,
      held: false,
      funding: { funded110, enteredTg },
    });
    expect(retentionDue(record("unknown"), perClass, "2026-06-01")).toEqual({
      kind: "blocked",
      reason: "funding_unknown",
    });
    expect(retentionDue(record("known_no"), perClass, "2026-06-01").kind).toBe("due");
    expect(retentionDue(record("unknown", true), perClass, "2026-06-01").kind).toBe("due");
    // The personnel file doesn't depend on it.
    expect(
      retentionDue(
        {
          ...item("personnel_file", nonSigner),
          funding: { funded110: "unknown", enteredTg: false },
        },
        perClass,
        "2026-06-01",
      ).kind,
    ).toBe("due");
  });

  it("is unset when a trigger has no span, or two", () => {
    const twice: RetentionPeriods = {
      ...perClass,
      personnel_file: {
        days: { non_signer_withdrawn: 90, closed_without_tg: 1, exited: 1 },
        months: { exited: 1 },
      },
    };
    expect(retentionDue(item("personnel_file", nonSigner), twice, "2027-01-01").kind).toBe(
      "period_unset",
    );
    const missing: RetentionPeriods = {
      ...perClass,
      health_record: { days: { non_signer_withdrawn: 90 } },
    };
    expect(retentionDue(item("health_record", nonSigner), missing, "2027-01-01").kind).toBe(
      "period_unset",
    );
    expect(
      credentialCutoff({ ...synthetic, access_credential: { months: { ended: 1 } } }, "2026-02-01"),
    ).toBeNull();
    expect(
      credentialCutoff(
        { ...synthetic, access_credential: { days: { ended: 1 }, yearEnds: { ended: 1 } } },
        "2026-02-01",
      ),
    ).toBeNull();
  });
});

describe("evidenceOnlyApplies (Q64)", () => {
  it("applies only with an evidence set and every other class deleted", () => {
    expect(evidenceOnlyApplies(["participation_record", "audit_log"], "unknown", true)).toBe(
      "applies",
    );
    expect(evidenceOnlyApplies(["participation_record", "evidence_set"], "known_yes", false)).toBe(
      "applies",
    );
    expect(
      evidenceOnlyApplies(["participation_record", "personnel_file"], "known_yes", false),
    ).toBe("classes_left");
    expect(evidenceOnlyApplies(["participation_record"], "known_no", false)).toBe(
      "no_evidence_set",
    );
    expect(evidenceOnlyApplies(["participation_record"], "unknown", false)).toBe("funding_unknown");
  });
});
