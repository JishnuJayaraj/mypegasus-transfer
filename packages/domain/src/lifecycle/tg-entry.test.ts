import { describe, expect, it } from "vitest";
import type { TgEntryKind } from "./enums";
import type { DatedFact, GuardFacts } from "./guards";
import { context } from "./testing/context";
import { canTransition, type TransitionContext } from "./transition";

// TG start 2027-04-01 (the wave default); that day's run was scheduled for 04:15 Berlin.
const tgStart = "2027-04-01";
const scheduledAt = new Date("2027-04-01T02:15:00Z");
const validOn = { before: "2027-03-30", on: tgStart, after: "2027-04-02" } as const;
const recordedAt = {
  before: new Date("2027-04-01T02:00:00Z"),
  after: new Date("2027-04-01T05:00:00Z"),
} as const;

const kinds: Record<TgEntryKind, Partial<TransitionContext>> = {
  scheduled_entry: { actor: { type: "system" }, today: tgStart, scheduledAt },
  scheduled_entry_catchup: { actor: { type: "system" }, today: "2027-04-03", scheduledAt },
  reconciliation: { today: "2027-04-03" },
};

type FactState = null | [keyof typeof validOn, keyof typeof recordedAt];
const states: FactState[] = [null];
for (const v of ["before", "on", "after"] as const) {
  for (const r of ["before", "after"] as const) states.push([v, r]);
}
const fact = (state: FactState): DatedFact | undefined =>
  state ? { validOn: validOn[state[0]], recordedAt: recordedAt[state[1]] } : undefined;

/** The rule of plan 5.3 / Q68, restated: valid by tgStart; system kinds also recorded by then. */
function oracle(kind: TgEntryKind, facts: FactState[]): boolean {
  return facts.every(
    (s) => s !== null && s[0] !== "after" && (kind === "reconciliation" || s[1] === "before"),
  );
}

function enter(kind: TgEntryKind, facts: GuardFacts, extra: Partial<TransitionContext> = {}) {
  return canTransition("main", "informed", "active_in_tg", {
    ...context({ ...kinds[kind], facts, ...extra }),
    entryKind: kind,
  });
}

describe("TG entry, the three cases (AC-4)", () => {
  it.each(["profilingDone", "profilingExceptionApproved"] as const)(
    "every combination of facts × validity × recording × entry kind, profiling via %s",
    (profilingFact) => {
      const mismatches: string[] = [];
      let cases = 0;
      for (const kind of Object.keys(kinds) as TgEntryKind[]) {
        for (const dsv of states) {
          for (const asu of states) {
            for (const profiling of states) {
              cases++;
              const facts = {
                dsvFullyExecuted: fact(dsv),
                asuRegisteredWithProof: fact(asu),
                [profilingFact]: fact(profiling),
              };
              const result = enter(kind, facts);
              if (result.ok !== oracle(kind, [dsv, asu, profiling])) {
                mismatches.push(JSON.stringify({ kind, dsv, asu, profiling }));
              }
            }
          }
        }
      }
      expect(cases).toBe(3 * 7 ** 3);
      expect(mismatches).toEqual([]);
    },
  );

  const everyGuardFailed = {
    ok: false,
    code: "guard_failed",
    failedGuards: [
      "dsv_fully_executed",
      "asu_registered_with_proof",
      "profiling_done_or_approved_exception",
      "tg_start_date",
    ],
  };

  const allValid: GuardFacts = {
    dsvFullyExecuted: fact(["on", "before"]),
    asuRegisteredWithProof: fact(["before", "before"]),
    profilingDone: fact(["before", "before"]),
  };

  it("names every failed guard", () => {
    expect(enter("scheduled_entry", {})).toEqual({
      ok: false,
      code: "guard_failed",
      failedGuards: [
        "dsv_fully_executed",
        "asu_registered_with_proof",
        "profiling_done_or_approved_exception",
      ],
    });
  });

  it("flags only reconciliations for review (Q80)", () => {
    expect(enter("scheduled_entry", allValid)).toEqual({ ok: true, flagForReview: false });
    expect(enter("scheduled_entry_catchup", allValid)).toEqual({ ok: true, flagForReview: false });
    expect(enter("reconciliation", allValid)).toEqual({ ok: true, flagForReview: true });
  });

  it.each([
    ["scheduled entry on another day", "scheduled_entry", { today: "2027-04-02" }],
    ["catch-up on the start day itself", "scheduled_entry_catchup", { today: tgStart }],
    ["catch-up before the start day", "scheduled_entry_catchup", { today: "2027-03-31" }],
    ["reconciliation before that day's run completed", "reconciliation", { today: tgStart }],
    ["reconciliation before the start day", "reconciliation", { today: "2027-03-31" }],
  ] as const)("tg_start_date fails: %s", (_, kind, extra) => {
    expect(enter(kind, allValid, extra)).toEqual({
      ok: false,
      code: "guard_failed",
      failedGuards: ["tg_start_date"],
    });
  });

  it.each(["scheduled_entry", "scheduled_entry_catchup"] as const)(
    "%s fails closed without the scheduled run time: nothing to snapshot against",
    (kind) => {
      expect(enter(kind, allValid, { scheduledAt: undefined })).toEqual(everyGuardFailed);
    },
  );

  it("fails closed without any TG start date", () => {
    expect(enter("reconciliation", allValid, { wave: null })).toEqual(everyGuardFailed);
  });

  it("allows reconciliation on the start day once that day's run completed and failed", () => {
    expect(
      enter("reconciliation", allValid, { today: tgStart, scheduledRunCompleted: true }).ok,
    ).toBe(true);
  });

  it("uses the participation's own TG start over the wave default", () => {
    const participation = { tgStart: "2027-04-15", offerDeadline: null };
    expect(enter("scheduled_entry", allValid, { participation }).ok).toBe(false);
    expect(enter("scheduled_entry", allValid, { participation, today: "2027-04-15" }).ok).toBe(
      true,
    );
  });

  it("is never possible in a ta_only project", () => {
    expect(enter("reconciliation", allValid, { projectType: "ta_only" })).toEqual({
      ok: false,
      code: "no_edge",
      failedGuards: [],
    });
  });
});
