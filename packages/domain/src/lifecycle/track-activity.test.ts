import { describe, expect, it } from "vitest";
import type { DsvStatus, MainStatus, ProfilingStatus } from "./enums";
import type { DatedFact } from "./guards";
import { context } from "./testing/context";
import { canTransition, type TransitionContext } from "./transition";

const approved: DatedFact = { validOn: "2027-02-20", recordedAt: new Date("2027-02-20T10:00:00Z") };

function profiling(
  status: MainStatus,
  from: ProfilingStatus,
  to: ProfilingStatus,
  extra: Partial<TransitionContext> = {},
) {
  const ctx = context(extra);
  const current = { ...ctx.current, status, profilingStatus: from };
  return canTransition("profiling", from, to, { ...ctx, current });
}

function dsv(
  status: MainStatus,
  from: DsvStatus,
  to: DsvStatus,
  extra: Partial<TransitionContext>,
) {
  const ctx = context(extra);
  const current = { ...ctx.current, status, dsvStatus: from };
  return canTransition("dsv", from, to, { ...ctx, current });
}

const inactive = { ok: false, code: "track_inactive", failedGuards: [] };
const allowed = { ok: true, flagForReview: false };

describe("track activity (AC-2)", () => {
  it.each(["imported", "contacted", "unreachable", "active_in_tg", "withdrawn", "exited"] as const)(
    "the profiling track doesn't move while the main status is %s",
    (status) => {
      expect(profiling(status, "not_started", "profiling_accepted")).toEqual(inactive);
    },
  );

  it("both tracks move while informed", () => {
    expect(profiling("informed", "not_started", "profiling_accepted")).toEqual(allowed);
    expect(dsv("informed", "dsv_offered", "dsv_declined", {})).toEqual(allowed);
  });

  it("the DSV track never moves in ta_only, nor outside informed", () => {
    expect(dsv("informed", "dsv_offered", "dsv_declined", { projectType: "ta_only" })).toEqual(
      inactive,
    );
    expect(dsv("contacted", "dsv_offered", "dsv_declined", {})).toEqual(inactive);
    expect(dsv("active_in_tg", "dsv_offered", "dsv_declined", {})).toEqual(inactive);
  });

  describe("in the TG with an approved profiling exception (Q74)", () => {
    const facts = { profilingExceptionApproved: approved };

    it.each([
      ["not_started", "profiling_accepted"],
      ["profiling_accepted", "profiling_in_progress"],
      ["not_started", "profiling_declined"],
      ["profiling_accepted", "profiling_declined"],
      ["profiling_in_progress", "profiling_declined"],
    ] as const)("records %s → %s", (from, to) => {
      expect(profiling("active_in_tg", from, to, { facts })).toEqual(allowed);
    });

    it("records profiling_done with the signed TL 407", () => {
      const done = { ...facts, tl407Signed: approved };
      expect(
        profiling("active_in_tg", "profiling_in_progress", "profiling_done", { facts: done }),
      ).toEqual(allowed);
    });

    it("doesn't reopen a refusal", () => {
      expect(
        profiling("active_in_tg", "profiling_declined", "profiling_accepted", { facts }),
      ).toEqual(inactive);
    });

    it("ignores an approval dated in the future", () => {
      const later = { profilingExceptionApproved: { ...approved, validOn: "2027-03-02" } };
      expect(
        profiling("active_in_tg", "not_started", "profiling_accepted", { facts: later }),
      ).toEqual(inactive);
    });
  });
});

describe("actors and entry kinds (AC-3)", () => {
  const notAllowed = { ok: false, code: "actor_not_allowed", failedGuards: [] };
  const system = { type: "system" } as const;

  it.each([
    ["system, reconciliation", { actor: system, entryKind: "reconciliation" }],
    ["user, scheduled_entry", { entryKind: "scheduled_entry" }],
    ["user, scheduled_entry_catchup", { entryKind: "scheduled_entry_catchup" }],
    [
      "participant, reconciliation",
      { actor: { type: "participant" }, entryKind: "reconciliation" },
    ],
    ["no entry kind", {}],
  ] as const)("TG entry rejects %s", (_, extra) => {
    expect(canTransition("main", "informed", "active_in_tg", context(extra))).toEqual(notAllowed);
  });

  it("rejects an entry kind on any other edge", () => {
    const ctx = context({ entryKind: "reconciliation", endReason: "placed_direct" });
    expect(canTransition("main", "informed", "withdrawn", ctx)).toEqual(notAllowed);
  });

  it("system-only edges reject staff, staff-only edges reject the system", () => {
    expect(dsv("informed", "dsv_offered", "dsv_expired", {})).toEqual(notAllowed);
    expect(dsv("informed", "dsv_offered", "dsv_expired", { actor: system })).toEqual(allowed);
    expect(profiling("informed", "not_started", "profiling_accepted", { actor: system })).toEqual(
      notAllowed,
    );
  });

  it("participants take no lifecycle transition (Q60)", () => {
    const participant = { type: "participant" } as const;
    expect(
      profiling("informed", "not_started", "profiling_accepted", { actor: participant }),
    ).toEqual(notAllowed);
    const ctx = context({ actor: participant, endReason: "placed_direct" });
    expect(canTransition("main", "informed", "withdrawn", ctx)).toEqual(notAllowed);
  });
});
