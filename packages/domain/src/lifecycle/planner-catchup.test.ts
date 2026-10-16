import { describe, expect, it } from "vitest";
import type { DatedFact, GuardFacts } from "./guards";
import { planSystemTransitions } from "./planner";
import { project, replay, runDay, snapshot, state, window } from "./testing/planner";

// The wave: default TG start 2027-04-01, signing deadline 2027-03-15, cutoff 2027-05-01.
// The last completed run was on 2027-03-29; the runs of 03-30 to 04-02 were missed.
const outage = window("2027-03-29", "2027-04-02");
const before: DatedFact = { validOn: "2027-03-20", recordedAt: new Date("2027-03-20T10:00:00Z") };
const ready: GuardFacts = {
  dsvFullyExecuted: before,
  asuRegisteredWithProof: before,
  profilingDone: before,
};
const signed = state("informed", "profiling_done", "dsv_signed");
const entrant = (facts: GuardFacts = ready, tgStart: string | null = null) =>
  snapshot({
    current: signed,
    facts,
    participation: { tgStart, offerDeadline: null, tgEntryDate: null },
  });

describe("TG entry and the catch-up window (AC-10, Q68, rounds 8–9)", () => {
  it("covers the days after the last completed run", () => {
    expect(outage.days.map((d) => d.day)).toEqual([
      "2027-03-30",
      "2027-03-31",
      "2027-04-01",
      "2027-04-02",
    ]);
  });

  it("catches up a missed start day when the facts were valid and recorded by its run", () => {
    const { changes, flags } = planSystemTransitions(entrant(), project, outage);
    expect(changes).toEqual([
      {
        track: "main",
        from: "informed",
        to: "active_in_tg",
        effectiveDate: "2027-04-01",
        entryKind: "scheduled_entry_catchup",
        scheduledAt: runDay("2027-04-01").scheduledAt,
      },
    ]);
    expect(flags).toEqual([]);
    replay(entrant(), changes, "ta_tg", "2027-04-02");
  });

  it("enters on the start day itself as scheduled_entry", () => {
    const { changes } = planSystemTransitions(entrant(ready, "2027-04-02"), project, outage);
    expect(changes.map((c) => [c.entryKind, c.effectiveDate])).toEqual([
      ["scheduled_entry", "2027-04-02"],
    ]);
  });

  it("evidence recorded after that day's run never enters automatically, only flags", () => {
    // 04:15 Berlin on 2027-04-01 is 02:15Z; the run had completed before this recording.
    const late = { ...before, recordedAt: new Date("2027-04-01T02:16:00Z") };
    const plan = planSystemTransitions(
      entrant({ ...ready, asuRegisteredWithProof: late }),
      project,
      outage,
    );
    expect(plan).toEqual({ changes: [], flags: ["tg_start_missed"] });
  });

  it("a fact valid only after the start never enters", () => {
    const after = { ...before, validOn: "2027-04-02" };
    const plan = planSystemTransitions(
      entrant({ ...ready, profilingDone: after }),
      project,
      outage,
    );
    expect(plan).toEqual({ changes: [], flags: ["tg_start_missed"] });
  });

  it("doesn't re-evaluate a completed day", () => {
    const plan = planSystemTransitions(entrant(ready, "2027-03-29"), project, outage);
    expect(plan).toEqual({ changes: [], flags: ["tg_start_missed"] });
  });

  it.each([
    ["dsv_offered", ["dsv_expired"]],
    ["dsv_expired", []],
    ["dsv_declined", []],
  ] as const)(
    "never plans an entry whose DSV track is %s, whatever the facts say (Q97)",
    (dsvStatus, expected) => {
      const inconsistent = snapshot({
        current: state("informed", "profiling_done", dsvStatus),
        facts: ready,
        participation: { tgStart: null, offerDeadline: null, tgEntryDate: null },
      });
      const plan = planSystemTransitions(inconsistent, project, outage);
      expect(plan.changes.map((c) => c.to)).toEqual(expected);
      expect(plan.flags).toContain("tg_start_missed");
    },
  );

  it("a second run plans nothing", () => {
    const first = planSystemTransitions(entrant(), project, outage);
    const after = replay(entrant(), first.changes, "ta_tg", "2027-04-02");
    expect(planSystemTransitions(after, project, outage).changes).toEqual([]);
    expect(
      planSystemTransitions(after, project, { days: [], today: "2027-04-02" }).changes,
    ).toEqual([]);
    expect(planSystemTransitions(entrant(), project, { days: [], today: "2027-04-02" })).toEqual({
      changes: [],
      flags: ["tg_start_missed"],
    });
  });
});

const offered = (
  current = state("informed", "not_started", "dsv_offered"),
  wave = snapshot().wave,
) => snapshot({ current, wave });

describe("state-based rules catch up after an outage (AC-10)", () => {
  it("DSV expiry takes effect the day after the deadline", () => {
    const { changes } = planSystemTransitions(
      offered(),
      project,
      window("2027-03-14", "2027-03-20"),
    );
    expect(changes).toEqual([
      { track: "dsv", from: "dsv_offered", to: "dsv_expired", effectiveDate: "2027-03-16" },
    ]);
    replay(offered(), changes, "ta_tg", "2027-03-20");
  });

  it("doesn't expire on the deadline, without a deadline, or outside informed", () => {
    expect(planSystemTransitions(offered(), project, window(null, "2027-03-15")).changes).toEqual(
      [],
    );
    const noDeadline = { ...snapshot().wave!, signingDeadline: null };
    expect(
      planSystemTransitions(offered(undefined, noDeadline), project, window(null, "2027-03-20"))
        .changes,
    ).toEqual([]);
    const withdrawn = state("withdrawn", "not_started", "dsv_offered");
    expect(
      planSystemTransitions(offered(withdrawn), project, window(null, "2027-03-20")).changes,
    ).toEqual([]);
  });

  it("an expiry and a cutoff withdrawal in one run, both effective on their own dates", () => {
    const { changes } = planSystemTransitions(
      offered(),
      project,
      window("2027-03-10", "2027-05-03"),
    );
    expect(changes.map((c) => [c.to, c.effectiveDate, c.endReason])).toEqual([
      ["dsv_expired", "2027-03-16", undefined],
      ["withdrawn", "2027-05-01", "no_response"],
    ]);
    replay(offered(), changes, "ta_tg", "2027-05-03");
  });

  it("an entry caught up during the outage isn't withdrawn at the cutoff", () => {
    const { changes } = planSystemTransitions(
      entrant(ready, "2027-04-29"),
      project,
      window("2027-04-27", "2027-05-03"),
    );
    expect(changes.map((c) => [c.to, c.entryKind, c.effectiveDate])).toEqual([
      ["active_in_tg", "scheduled_entry_catchup", "2027-04-29"],
    ]);
  });
});
