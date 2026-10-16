import { describe, expect, it } from "vitest";
import type { IsoDate } from "../iso-date";
import {
  DsvStatus,
  ProfilingStatus,
  type EndReason,
  type LifecycleFlag,
  type MainStatus,
} from "./enums";
import { lifecycleFlags, planSystemTransitions, projectFlags } from "./planner";
import { wave } from "./testing/context";
import { project, replay, snapshot, state, window } from "./testing/planner";

// The wave: signing deadline 2027-03-15, latest entry 2027-04-30, so the cutoff is 2027-05-01.
// No TG start, so the entry rule stays out of the way.
const noStart = { ...wave, defaultTgStart: null };
const cutoffFlags = new Set<LifecycleFlag>([
  "conflict_dsv_signed_profiling_declined",
  "dsv_never_offered",
  "informed_without_wave_at_cutoff",
  "cutoff_warning",
  "cutoff_final_reminder",
]);

type Expected = { reasons: EndReason[] } | { flag: LifecycleFlag } | null;

/** Plan 5.3, rule 3 and Q84, restated: what the cutoff does to one state. */
function oracle(
  status: MainStatus,
  profiling: ProfilingStatus,
  dsv: DsvStatus,
  hasWave: boolean,
): Expected {
  // An open offer expired at its deadline (≤ latestEntryDate) when the DSV track is active.
  const d = dsv === "dsv_offered" && status === "informed" && hasWave ? "dsv_expired" : dsv;
  if (d === "dsv_signed" && profiling === "profiling_declined") {
    return { flag: "conflict_dsv_signed_profiling_declined" };
  }
  if (status === "informed" && !hasWave) return { flag: "informed_without_wave_at_cutoff" };
  if (status === "informed" && d === "not_offered") return { flag: "dsv_never_offered" };
  // The system never withdraws with a signed DSV (withdrawal_after_dsv_signed).
  if (d === "dsv_signed") return null;
  const reasons: EndReason[] = [];
  if (d === "dsv_declined") reasons.push("declined_dsv");
  if (profiling === "profiling_declined") reasons.push("declined_profiling");
  if (d === "dsv_expired" || status === "unreachable") reasons.push("no_response");
  if (status === "imported") reasons.push("never_contacted");
  if (status === "contacted") reasons.push("not_informed");
  return reasons.length ? { reasons } : null;
}

function* combinations(): Generator<Combination> {
  for (const status of ["imported", "contacted", "unreachable", "informed"] as const)
    for (const profiling of ProfilingStatus.options)
      for (const dsv of DsvStatus.options)
        for (const hasWave of [true, false]) yield { status, profiling, dsv, hasWave };
}

type Combination = {
  status: MainStatus;
  profiling: ProfilingStatus;
  dsv: DsvStatus;
  hasWave: boolean;
};

function plan(c: Combination, today: IsoDate, type = project.type) {
  const s = snapshot({
    current: state(c.status, c.profiling, c.dsv),
    wave: c.hasWave ? noStart : null,
  });
  const p = { type, waves: [noStart] };
  const result = planSystemTransitions(s, p, window(null, today));
  replay(s, result.changes, type, today);
  return result;
}

describe("cutoff withdrawals (AC-9, Q70, Q84)", () => {
  it("every combination on the cutoff day gives the reason, the secondary list or the flag", () => {
    const mismatches: string[] = [];
    let count = 0;
    for (const c of combinations()) {
      count++;
      const { changes, flags } = plan(c, "2027-05-01");
      const withdrawal = changes.find((ch) => ch.to === "withdrawn");
      const flag = flags.find((f) => cutoffFlags.has(f));
      const actual: Expected = withdrawal
        ? { reasons: [withdrawal.endReason!, ...withdrawal.secondaryReasons!] }
        : flag
          ? { flag }
          : null;
      const expected = oracle(c.status, c.profiling, c.dsv, c.hasWave);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`${JSON.stringify(c)}: ${JSON.stringify(actual)}`);
      }
      if (withdrawal && withdrawal.effectiveDate !== "2027-05-01") {
        mismatches.push(`${JSON.stringify(c)}: effective ${withdrawal.effectiveDate}`);
      }
    }
    expect(count).toBe(4 * 5 * 5 * 2);
    expect(mismatches).toEqual([]);
  });

  it("nothing is withdrawn on the latest entry date itself, nor in ta_only", () => {
    for (const c of combinations()) {
      expect(plan(c, "2027-04-30").changes.filter((ch) => ch.to === "withdrawn")).toEqual([]);
      const taOnly = plan({ ...c, hasWave: false }, "2027-05-01", "ta_only");
      expect([taOnly.changes, taOnly.flags]).toEqual([[], []]);
    }
  });

  it("uses the primary reason by precedence and keeps the others", () => {
    const { changes } = plan(
      { status: "informed", profiling: "profiling_declined", dsv: "dsv_declined", hasWave: true },
      "2027-05-03",
    );
    expect(changes).toEqual([
      {
        track: "main",
        from: "informed",
        to: "withdrawn",
        effectiveDate: "2027-05-01",
        endReason: "declined_dsv",
        secondaryReasons: ["declined_profiling"],
      },
    ]);
  });
});

describe("participations without a wave (Q84, round 9)", () => {
  const later = { ...noStart, id: "wave-2", latestEntryDate: "2027-06-30" };
  const twoWaves = { type: "ta_tg" as const, waves: [noStart, later] };
  const imported = snapshot({ current: state("imported"), wave: null });

  it("use the project's final entry date", () => {
    expect(planSystemTransitions(imported, twoWaves, window(null, "2027-06-30")).changes).toEqual(
      [],
    );
    expect(planSystemTransitions(imported, twoWaves, window(null, "2027-07-01")).changes).toEqual([
      {
        track: "main",
        from: "imported",
        to: "withdrawn",
        effectiveDate: "2027-07-01",
        endReason: "never_contacted",
        secondaryReasons: [],
      },
    ]);
  });

  it("are not withdrawn while a wave lacks its latest entry date; the project is flagged", () => {
    const draft = { type: "ta_tg" as const, waves: [noStart, { ...later, latestEntryDate: null }] };
    expect(planSystemTransitions(imported, draft, window(null, "2027-09-01"))).toEqual({
      changes: [],
      flags: [],
    });
    expect(projectFlags(draft)).toEqual(["latest_entry_date_missing"]);
  });
});

describe("missing dates (plan 5.3, rule 6)", () => {
  it("a wave without a latest entry date moves nothing", () => {
    const s = snapshot({
      current: state("contacted"),
      wave: { ...noStart, latestEntryDate: null },
    });
    expect(planSystemTransitions(s, project, window(null, "2027-12-01"))).toEqual({
      changes: [],
      flags: [],
    });
  });

  it.each([
    ["no wave", { type: "ta_tg", waves: [] }, ["latest_entry_date_missing"]],
    [
      "a wave without a date",
      { type: "ta_tg", waves: [{ ...wave, latestEntryDate: null }] },
      ["latest_entry_date_missing"],
    ],
    ["every wave dated", project, []],
    ["ta_only", { type: "ta_only", waves: [] }, []],
  ] as const)("project flags with %s", (_, p, flags) => {
    expect(projectFlags(p)).toEqual(flags);
  });
});

const flagsOn = (today: IsoDate, current = state("imported")) =>
  lifecycleFlags(snapshot({ current, wave: noStart }), project, today);

describe("cutoff warnings (Q78)", () => {
  it.each([
    ["2027-04-16", []],
    ["2027-04-17", ["cutoff_warning"]],
    ["2027-04-27", ["cutoff_warning"]],
    ["2027-04-28", ["cutoff_warning", "cutoff_final_reminder"]],
    ["2027-04-30", ["cutoff_warning", "cutoff_final_reminder"]],
  ] as const)("on %s: %j", (today, flags) => {
    expect(flagsOn(today)).toEqual(flags);
  });

  it("warn whoever the cutoff would withdraw or flag, an open offer included", () => {
    const warned = ["cutoff_warning", "cutoff_final_reminder"];
    expect(flagsOn("2027-04-28", state("informed"))).toEqual(warned);
    expect(flagsOn("2027-04-28", state("informed", "not_started", "dsv_offered"))).toEqual(warned);
    expect(flagsOn("2027-04-28", state("informed", "profiling_done", "dsv_signed"))).toEqual([]);
    expect(flagsOn("2027-04-28", state("active_in_tg", "profiling_done", "dsv_signed"))).toEqual(
      [],
    );
  });

  it("stop at the cutoff, when the withdrawal or the flag takes over", () => {
    expect(flagsOn("2027-05-01")).toEqual([]);
    expect(flagsOn("2027-05-01", state("informed"))).toEqual(["dsv_never_offered"]);
  });
});
