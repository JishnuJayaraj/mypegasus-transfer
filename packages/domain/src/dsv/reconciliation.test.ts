import { describe, expect, it } from "vitest";
import {
  ReconciliationReviewRequest,
  TgEntryReconciliationRequest,
  reconciliationAwaitsReview,
  reconciliationClarificationOpen,
  reconciliationEvidence,
  reconciliationOutcomes,
  reconciliationReviewDueOn,
  reconciliationTiming,
  replyReconciliation,
  reviewReconciliation,
  sameEvidence,
  type EntryEvidence,
  type ReconciliationStage,
} from "./reconciliation";

// process-and-lifecycle.md, TG entry guard ("Entry after the planned date", case 2); Q68, Q80, Q216.
const tgStart = "2027-03-01";
const at = new Date("2027-03-05T10:00:00Z");
const rec = (id: string, validOn: string) => ({ id, validOn, recordedAt: at });
const all: EntryEvidence = {
  packet: rec("p", "2027-02-20"),
  asu: rec("a", "2027-02-10"),
  tl407: rec("t", "2027-02-01"),
  exception: null,
};

describe("reconciliationEvidence", () => {
  it("lists every fact valid on the TG start, recorded later (the quarantine lifted after the run)", () => {
    expect(reconciliationEvidence(all, tgStart)).toEqual({
      ok: true,
      evidence: [
        { kind: "dsv_packet", id: "p", validOn: "2027-02-20", recordedAt: at },
        { kind: "asu_registration", id: "a", validOn: "2027-02-10", recordedAt: at },
        { kind: "tl407", id: "t", validOn: "2027-02-01", recordedAt: at },
      ],
    });
  });

  it("is valid on the TG start day itself, never after it", () => {
    const onStart = { ...all, packet: rec("p", tgStart) };
    expect(reconciliationEvidence(onStart, tgStart).ok).toBe(true);
    const later = { ...all, packet: rec("p", "2027-03-02") };
    expect(reconciliationEvidence(later, tgStart)).toMatchObject({
      ok: false,
      problems: [{ fact: "dsv_packet", code: "evidence_after_tg_start" }],
      // Listed with its actual day all the same.
      evidence: [{ kind: "dsv_packet", validOn: "2027-03-02" }, {}, {}],
    });
  });

  it("takes the approved exception when the TL 407 came later, the TL 407 when both held", () => {
    const exception = rec("e", "2027-02-15");
    const late = { ...all, tl407: rec("t", "2027-03-03"), exception };
    expect(reconciliationEvidence(late, tgStart)).toMatchObject({
      ok: true,
      evidence: [{}, {}, { kind: "profiling_exception", id: "e" }],
    });
    expect(reconciliationEvidence({ ...all, exception }, tgStart)).toMatchObject({
      evidence: [{}, {}, { kind: "tl407", id: "t" }],
    });
    // Both after the start: the TL 407 is named as the fact that came too late.
    const bothLate = { ...all, tl407: rec("t", "2027-03-03"), exception: rec("e", "2027-03-04") };
    expect(reconciliationEvidence(bothLate, tgStart)).toMatchObject({
      ok: false,
      problems: [{ fact: "profiling", code: "evidence_after_tg_start" }],
    });
    const onlyLateException = { ...all, tl407: null, exception: rec("e", "2027-03-04") };
    expect(reconciliationEvidence(onlyLateException, tgStart)).toMatchObject({
      ok: false,
      problems: [{ fact: "profiling", code: "evidence_after_tg_start" }],
    });
  });

  it("names every missing fact", () => {
    const none = { packet: null, asu: null, tl407: null, exception: null };
    expect(reconciliationEvidence(none, tgStart)).toEqual({
      ok: false,
      problems: [
        { fact: "dsv_packet", code: "evidence_missing" },
        { fact: "asu_registration", code: "evidence_missing" },
        { fact: "profiling", code: "evidence_missing" },
      ],
      evidence: [],
    });
  });
});

describe("sameEvidence", () => {
  const read = [
    { kind: "dsv_packet" as const, id: "11111111-1111-4111-8111-111111111111", validOn: "2027-02-20" },
    { kind: "tl407" as const, id: "22222222-2222-4222-8222-222222222222", validOn: "2027-02-01" },
  ];
  it("is the same records with the same days, in any order", () => {
    expect(sameEvidence(read, [...read].reverse())).toBe(true);
  });
  it("differs on another record, another day, a missing or a duplicated one", () => {
    expect(sameEvidence(read, [read[0]!, { ...read[1]!, validOn: "2027-02-02" }])).toBe(false);
    expect(sameEvidence(read, [read[0]!, { ...read[1]!, kind: "profiling_exception" }])).toBe(
      false,
    );
    expect(sameEvidence(read, [read[0]!])).toBe(false);
    expect(sameEvidence([read[0]!, read[0]!], read)).toBe(false);
  });
});

describe("the review's state machine (Q216)", () => {
  const stages: ReconciliationStage[] = [
    "requested",
    "no_objection",
    "clarification_requested",
    "replied",
    "escalated_to_dpo",
    "resolved_no_objection",
  ];
  it("opens the outcomes of each stage that awaits the manager", () => {
    expect(Object.fromEntries(stages.map((s) => [s, reconciliationOutcomes(s)]))).toEqual({
      requested: ["no_objection", "clarification_requested"],
      no_objection: [],
      clarification_requested: [],
      replied: ["resolved_no_objection", "escalated_to_dpo", "clarification_requested"],
      escalated_to_dpo: ["resolved_no_objection"],
      resolved_no_objection: [],
    });
    expect(stages.filter(reconciliationAwaitsReview)).toEqual([
      "requested",
      "replied",
      "escalated_to_dpo",
    ]);
  });

  it("keeps a clarification open through the reply and an escalation until it is resolved", () => {
    expect(stages.filter(reconciliationClarificationOpen)).toEqual([
      "clarification_requested",
      "replied",
      "escalated_to_dpo",
    ]);
  });

  const review = (over: Partial<Parameters<typeof reviewReconciliation>[0]> = {}) =>
    reviewReconciliation({
      stage: "requested",
      reconciledBy: "pl",
      reviewer: "manager",
      permitted: true,
      outcome: "no_objection",
      ...over,
    });

  it("refuses another role, the PL who reconciled, a closed stage and an outcome not open", () => {
    expect(review()).toEqual({ ok: true, next: "no_objection" });
    expect(review({ permitted: false })).toEqual({ ok: false, code: "actor_not_allowed" });
    // One person holding both roles never reviews their own reconciliation.
    expect(review({ reviewer: "pl" })).toEqual({ ok: false, code: "four_eyes" });
    expect(review({ stage: "clarification_requested" })).toEqual({
      ok: false,
      code: "not_awaiting",
    });
    expect(review({ stage: "no_objection" })).toEqual({ ok: false, code: "not_awaiting" });
    expect(review({ outcome: "escalated_to_dpo" })).toEqual({
      ok: false,
      code: "outcome_not_allowed",
    });
    expect(review({ stage: "escalated_to_dpo", outcome: "resolved_no_objection" })).toEqual({
      ok: true,
      next: "resolved_no_objection",
    });
  });

  it("takes the PL's reply only while the request awaits it", () => {
    expect(replyReconciliation("clarification_requested")).toEqual({ ok: true, next: "replied" });
    expect(replyReconciliation("replied")).toEqual({ ok: false, code: "not_awaiting" });
  });
});

describe("reconciliationReviewDueOn", () => {
  it("is the next business day, informational", () => {
    expect(reconciliationReviewDueOn("2027-03-01")).toBe("2027-03-02"); // Mon → Tue
    expect(reconciliationReviewDueOn("2027-03-05")).toBe("2027-03-08"); // Fri → Mon
    expect(reconciliationReviewDueOn("2027-03-06")).toBe("2027-03-08"); // Sat → Mon
    expect(reconciliationReviewDueOn("1970-01-03")).toBe("1970-01-05"); // before the anchor
  });
});

describe("reconciliationTiming (the guard tg_start_date, kind reconciliation)", () => {
  it("opens after the TG start, or on it once that day's run completed", () => {
    expect(reconciliationTiming(null, tgStart, false)).toBe("tg_start_missing");
    expect(reconciliationTiming(tgStart, "2027-02-28", true)).toBe("before_tg_start");
    expect(reconciliationTiming(tgStart, tgStart, false)).toBe("run_not_completed");
    expect(reconciliationTiming(tgStart, tgStart, true)).toBeNull();
    expect(reconciliationTiming(tgStart, "2027-03-02", false)).toBeNull();
  });
});

describe("the requests", () => {
  it("needs the PL's confirmation and never presets it", () => {
    const evidence = ["dsv_packet", "asu_registration", "tl407"].map((kind, i) => ({
      kind,
      id: `${i + 1}1111111-1111-4111-8111-111111111111`,
      validOn: tgStart,
    }));
    expect(
      TgEntryReconciliationRequest.safeParse({ evidence, statusVersion: 3, confirmed: true })
        .success,
    ).toBe(true);
    expect(
      TgEntryReconciliationRequest.safeParse({ evidence, statusVersion: 3, confirmed: false })
        .success,
    ).toBe(false);
    expect(TgEntryReconciliationRequest.safeParse({ evidence, statusVersion: 3 }).success).toBe(
      false,
    );
    const two = evidence.slice(0, 2);
    expect(
      TgEntryReconciliationRequest.safeParse({ evidence: two, statusVersion: 3, confirmed: true })
        .success,
    ).toBe(false);
  });

  it("needs a reason code and a source for a clarification, a source for a resolution", () => {
    const ok = (value: unknown) => ReconciliationReviewRequest.safeParse(value).success;
    expect(ok({ outcome: "no_objection", revision: 0 })).toBe(true);
    expect(ok({ outcome: "no_objection", revision: 0, source: "x" })).toBe(false);
    expect(ok({ outcome: "clarification_requested", source: "Akte 3", revision: 0 })).toBe(false);
    expect(
      ok({ outcome: "clarification_requested", code: "date_unclear", source: "Akte 3", revision: 0 }),
    ).toBe(true);
    expect(ok({ outcome: "escalated_to_dpo", revision: 1 })).toBe(false);
    expect(ok({ outcome: "resolved_no_objection", source: "Weisung DSB 4", revision: 2 })).toBe(
      true,
    );
  });
});
