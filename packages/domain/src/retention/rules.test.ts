import { describe, expect, it } from "vitest";
import { sample } from "../access/profiles";
import type { PermissionTarget } from "../access/permissions";
import type { ProjectRole } from "../enums";
import {
  credentialCutoff,
  evidenceOnlyApplies,
  evidenceSetDue,
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

  it("applies the configured stage-one classes and stage-two erasure", () => {
    expect(RetentionClass.options.filter((c) => retentionRules[c].applied)).toEqual([
      "participation_record",
      "personnel_file",
      "health_record",
      "access_credential",
      "evidence_set",
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
  funding: { funded110: "known_no" as const, enteredTg: false },
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

  it.each(["personnel_file", "health_record"] as const)(
    "applies the non-signer period to %s only when funding is known absent",
    (c) => {
      const funded = (funded110: "known_no" | "known_yes" | "unknown") => ({
        ...item(c, nonSigner),
        funding: { funded110, enteredTg: false },
      });
      expect(retentionDue(funded("known_no"), perClass, "2026-05-30").kind).toBe("not_due");
      expect(retentionDue(funded("known_no"), perClass, "2026-05-31").kind).toBe("due");
      expect(retentionDue(funded("unknown"), perClass, "2026-05-31")).toEqual({
        kind: "blocked",
        reason: "funding_unknown",
      });
      expect(retentionDue(funded("known_yes"), perClass, "2027-01-01")).toEqual({
        kind: "not_due",
        on: null,
      });
    },
  );

  it("fails closed when a non-signer's funding fact is absent", () => {
    expect(
      retentionDue(
        { class: "personnel_file", triggers: nonSigner, held: false },
        perClass,
        "2026-05-31",
      ),
    ).toEqual({ kind: "blocked", reason: "funding_unknown" });
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
        status: "withdrawn",
        dsvFullyExecuted: true,
      }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: "2026-04-02", exited: null });
    expect(
      participationRetentionTriggers({
        ...facts,
        withdrawnOn: null,
        status: "ta_completed",
        dsvFullyExecuted: false,
      }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: null, exited: null });
    // Without a recorded withdrawal day, the day it closed.
    expect(
      participationRetentionTriggers({
        ...facts,
        withdrawnOn: null,
        status: "withdrawn",
        dsvFullyExecuted: false,
      }).non_signer_withdrawn,
    ).toBe("2026-04-02");
    expect(
      participationRetentionTriggers({ ...facts, status: "informed", dsvFullyExecuted: false }),
    ).toEqual({ non_signer_withdrawn: null, closed_without_tg: null, exited: null });
  });

  it("leaves health after closure without TG unmapped", () => {
    const triggers = participationRetentionTriggers({
      status: "withdrawn",
      closedOn: "2026-04-01",
      withdrawnOn: "2026-04-01",
      enteredTg: false,
      dsvFullyExecuted: true,
    });
    expect(retentionDue(item("health_record", triggers), perClass, "2030-01-01")).toEqual({
      kind: "not_due",
      on: null,
    });
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
    // The non-signer personnel file also depends on funding.
    expect(
      retentionDue(
        {
          ...item("personnel_file", nonSigner),
          funding: { funded110: "unknown", enteredTg: false },
        },
        perClass,
        "2026-06-01",
      ).kind,
    ).toBe("blocked");
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
    const fraction: RetentionPeriods = {
      ...perClass,
      health_record: {
        days: { non_signer_withdrawn: 1.5 },
        months: { closed_without_tg: 3, exited: 3 },
      },
    };
    expect(retentionDue(item("health_record", nonSigner), fraction, "2027-01-01").kind).toBe(
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

describe("evidence-set expiry (data-protection.md, retention and deletion)", () => {
  const project = {
    anyEnteredTg: true,
    fundings: ["known_yes"] as const,
    kugFinalSettlementDate: "2025-03-01",
    measure110SettlementDate: "2026-06-01",
  };
  it("waits for the day after the end of the configured year", () => {
    expect(evidenceSetDue(project, 4, "2030-12-31")).toBe("not_due");
    expect(evidenceSetDue(project, 4, "2031-01-01")).toBe("due");
  });
  it("blocks unknown funding, missing required dates and unset periods", () => {
    expect(evidenceSetDue({ ...project, fundings: ["unknown"] }, 4, "2032-01-01")).toBe(
      "funding_unknown",
    );
    expect(evidenceSetDue({ ...project, kugFinalSettlementDate: null }, 4, "2032-01-01")).toBe(
      "settlement_missing",
    );
    expect(evidenceSetDue({ ...project, measure110SettlementDate: null }, 4, "2032-01-01")).toBe(
      "settlement_missing",
    );
    expect(evidenceSetDue(project, null, "2032-01-01")).toBe("period_unset");
    expect(evidenceSetDue(project, -1, "2032-01-01")).toBe("period_unset");
    expect(evidenceSetDue(project, 0.5, "2032-01-01")).toBe("period_unset");
    expect(
      evidenceSetDue({ ...project, anyEnteredTg: false, fundings: ["known_no"] }, 4, "2032-01-01"),
    ).toBe("settlement_missing");
    expect(
      evidenceSetDue(
        { ...project, anyEnteredTg: false, kugFinalSettlementDate: null },
        4,
        "2031-01-01",
      ),
    ).toBe("due");
    expect(
      evidenceSetDue(
        { ...project, fundings: ["known_no"], measure110SettlementDate: null },
        4,
        "2030-01-01",
      ),
    ).toBe("due");
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
