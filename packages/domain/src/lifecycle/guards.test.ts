import { describe, expect, it } from "vitest";
import type { DsvStatus } from "./enums";
import { guardIds, type DatedFact, type GuardFacts } from "./guards";
import { context } from "./testing/context";
import { canTransition, type TransitionContext } from "./transition";

const fact: DatedFact = { validOn: "2027-02-20", recordedAt: new Date("2027-02-20T10:00:00Z") };
const future: DatedFact = { ...fact, validOn: "2027-03-02" };
const failed = (...failedGuards: string[]) => ({ ok: false, code: "guard_failed", failedGuards });
const allowed = { ok: true, flagForReview: false };

function finishProfiling(facts: GuardFacts) {
  const ctx = context({ facts });
  const current = { ...ctx.current, profilingStatus: "profiling_in_progress" as const };
  return canTransition("profiling", "profiling_in_progress", "profiling_done", {
    ...ctx,
    current,
  });
}

function signDsv(facts: GuardFacts) {
  const ctx = context({ facts });
  const current = { ...ctx.current, dsvStatus: "dsv_offered" as const };
  return canTransition("dsv", "dsv_offered", "dsv_signed", { ...ctx, current });
}

describe("guards (AC-5)", () => {
  it("are exactly the plan's list", () => {
    expect(guardIds).toEqual([
      "dsv_fully_executed",
      "asu_registered_with_proof",
      "profiling_done_or_approved_exception",
      "tg_start_date",
      "ta_completion",
      "withdrawal_after_dsv_signed",
      "before_cutoff",
      "entry_wave_assigned",
      "offer_deadline_valid",
      "tl407_signed",
      "dsv_generated",
      "dsv_scan_received",
    ]);
  });

  it("have no override path (Q71)", () => {
    const ctx = { ...context(), override: true, overrideGuards: ["tl407_signed"] };
    const current = { ...ctx.current, profilingStatus: "profiling_in_progress" as const };
    expect(
      canTransition("profiling", "profiling_in_progress", "profiling_done", { ...ctx, current }),
    ).toEqual(failed("tl407_signed"));
  });

  it("tl407_signed: passes with the fact, fails without or dated after today", () => {
    expect(finishProfiling({ tl407Signed: fact })).toEqual(allowed);
    expect(finishProfiling({})).toEqual(failed("tl407_signed"));
    expect(finishProfiling({ tl407Signed: future })).toEqual(failed("tl407_signed"));
  });

  it("dsv_scan_received: passes with the fact, fails without or dated after today", () => {
    expect(signDsv({ dsvScanReceived: fact })).toEqual(allowed);
    expect(signDsv({})).toEqual(failed("dsv_scan_received"));
    expect(signDsv({ dsvScanReceived: future })).toEqual(failed("dsv_scan_received"));
  });
});

function withdraw(extra: Partial<TransitionContext>, dsvStatus: DsvStatus = "not_offered") {
  const ctx = context(extra);
  return canTransition("main", "informed", "withdrawn", {
    ...ctx,
    current: { ...ctx.current, dsvStatus },
  });
}

function exit(endReason?: TransitionContext["endReason"]) {
  const ctx = context({ endReason });
  const current = { ...ctx.current, status: "active_in_tg" as const };
  return canTransition("main", "active_in_tg", "exited", { ...ctx, current });
}

function complete(extra: Partial<TransitionContext>) {
  return canTransition(
    "main",
    "informed",
    "ta_completed",
    context({ projectType: "ta_only", ...extra }),
  );
}

describe("end reasons and terminal transitions (AC-8)", () => {
  it("manual withdrawal needs a pre-TG reason", () => {
    expect(withdraw({})).toEqual({ ok: false, code: "reason_required", failedGuards: [] });
    expect(withdraw({ endReason: "placed_permanent" })).toEqual({
      ok: false,
      code: "reason_wrong_phase",
      failedGuards: [],
    });
    expect(withdraw({ endReason: "placed_direct" })).toEqual(allowed);
    expect(withdraw({ endReason: "no_response", actor: { type: "system" } })).toEqual(allowed);
  });

  it("withdrawal after dsv_signed needs the cancellation and the PL's confirmation (verify Q46)", () => {
    const reason = { endReason: "placed_direct" } as const;
    const cancellation = { dsvCancellation: fact };
    expect(withdraw(reason, "dsv_signed")).toEqual(failed("withdrawal_after_dsv_signed"));
    expect(withdraw({ ...reason, facts: cancellation }, "dsv_signed")).toEqual(
      failed("withdrawal_after_dsv_signed"),
    );
    expect(withdraw({ ...reason, confirmed: true }, "dsv_signed")).toEqual(
      failed("withdrawal_after_dsv_signed"),
    );
    expect(withdraw({ ...reason, facts: cancellation, confirmed: true }, "dsv_signed")).toEqual(
      allowed,
    );
    const system = { endReason: "no_response", actor: { type: "system" } } as const;
    expect(withdraw({ ...system, facts: cancellation }, "dsv_signed")).toEqual(
      failed("withdrawal_after_dsv_signed"),
    );
  });

  it("an exit needs a TG reason; the health-related one isn't storable yet (Q66)", () => {
    expect(exit()).toEqual({ ok: false, code: "reason_required", failedGuards: [] });
    expect(exit("declined_dsv")).toEqual({
      ok: false,
      code: "reason_wrong_phase",
      failedGuards: [],
    });
    expect(exit("long_term_illness_reduced_earning_capacity")).toEqual({
      ok: false,
      code: "reason_not_storable",
      failedGuards: [],
    });
    expect(exit("placed_permanent")).toEqual(allowed);
  });

  it("ta_completed needs taMeasuresComplete and the PL's confirmation, not profiling_done (Q83)", () => {
    expect(complete({ facts: { profilingDone: fact }, confirmed: true })).toEqual(
      failed("ta_completion"),
    );
    expect(complete({ facts: { taMeasuresComplete: fact } })).toEqual(failed("ta_completion"));
    expect(complete({ facts: { taMeasuresComplete: fact }, confirmed: true })).toEqual(allowed);
  });
});
