import { describe, expect, it } from "vitest";
import type { ProjectType } from "../project";
import { DsvStatus, MainStatus, ProfilingStatus } from "./enums";
import { deriveOverallStatus, isConsistentState, type LifecycleState } from "./overall-status";

function* allStates(): Generator<LifecycleState> {
  for (const projectType of ["ta_tg", "ta_only"] as const)
    for (const status of MainStatus.options)
      for (const profilingStatus of ProfilingStatus.options)
        for (const dsvStatus of DsvStatus.options)
          for (const hasWave of [false, true])
            yield { projectType, status, profilingStatus, dsvStatus, hasWave };
}

// Consistent states per main status, counted by hand from the rules in plan 5.3:
// before `informed` the tracks haven't started; an offered DSV needs a wave; in or after the TG
// the DSV is signed; `ta_only` has no DSV, no wave and no TG; `ta_completed` is `ta_only` only.
const expected: Record<ProjectType, Partial<Record<MainStatus, number>>> = {
  ta_tg: {
    imported: 2,
    contacted: 2,
    unreachable: 2,
    informed: 5 * (2 + 4),
    withdrawn: 5 * (2 + 4),
    active_in_tg: 5,
    exited: 5,
  },
  ta_only: {
    imported: 1,
    contacted: 1,
    unreachable: 1,
    informed: 5,
    withdrawn: 5,
    ta_completed: 5,
  },
};

const state = (overrides: Partial<LifecycleState>): LifecycleState => ({
  projectType: "ta_tg",
  status: "informed",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  hasWave: true,
  ...overrides,
});

describe("derived overall status (AC-13)", () => {
  it("the consistent states are exactly the expected ones", () => {
    const counts: Record<string, Record<string, number>> = { ta_tg: {}, ta_only: {} };
    for (const s of allStates()) {
      if (!isConsistentState(s)) continue;
      const byType = counts[s.projectType]!;
      byType[s.status] = (byType[s.status] ?? 0) + 1;
    }
    expect(counts).toEqual(expected);
  });

  it.each([
    [
      "imported with profiling in progress",
      { status: "imported", profilingStatus: "profiling_in_progress" },
    ],
    ["contacted with a DSV offer", { status: "contacted", dsvStatus: "dsv_offered" }],
    [
      "ta_only with a DSV status",
      { projectType: "ta_only", hasWave: false, dsvStatus: "dsv_declined" },
    ],
    ["ta_only with a wave", { projectType: "ta_only" }],
    ["ta_only in the TG", { projectType: "ta_only", hasWave: false, status: "active_in_tg" }],
    ["ta_completed in ta_tg", { status: "ta_completed" }],
    ["dsv_offered without a wave", { dsvStatus: "dsv_offered", hasWave: false }],
    ["in the TG without a signed DSV", { status: "active_in_tg", dsvStatus: "dsv_declined" }],
    ["exited without a signed DSV", { status: "exited" }],
  ] as const)("rejects %s", (_, overrides) => {
    const s = state(overrides);
    expect(isConsistentState(s)).toBe(false);
    expect(() => deriveOverallStatus(s)).toThrow("Inconsistent lifecycle state");
  });

  it("gives every consistent state a key; the tracks show while informed and in the TG", () => {
    const keys = [...allStates()].filter(isConsistentState).map(deriveOverallStatus);
    expect(keys).toHaveLength(94);
    expect(keys.filter((key) => !key.startsWith("lifecycle.overall."))).toEqual([]);
    expect(
      deriveOverallStatus(
        state({ dsvStatus: "dsv_signed", profilingStatus: "profiling_in_progress" }),
      ),
    ).toBe("lifecycle.overall.informed.dsv_signed.profiling_in_progress");
    expect(deriveOverallStatus(state({ projectType: "ta_only", hasWave: false }))).toBe(
      "lifecycle.overall.informed.not_started",
    );
    expect(
      deriveOverallStatus(
        state({
          status: "active_in_tg",
          dsvStatus: "dsv_signed",
          profilingStatus: "profiling_declined",
        }),
      ),
    ).toBe("lifecycle.overall.active_in_tg.profiling_declined");
    expect(deriveOverallStatus(state({ status: "withdrawn", dsvStatus: "dsv_signed" }))).toBe(
      "lifecycle.overall.withdrawn",
    );
  });
});
