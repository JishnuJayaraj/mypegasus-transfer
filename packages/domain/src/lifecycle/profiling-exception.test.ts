import { describe, expect, it } from "vitest";
import type { DatedFact } from "./guards";
import {
  approvedExceptionFact,
  decideProfilingException,
  noProfilingException,
  requestProfilingException,
  revokeProfilingException,
  type ExceptionRequest,
  type OperationContext,
  type ProfilingException,
} from "./operations";
import { context } from "./testing/context";
import { canTransition } from "./transition";

const evidence: DatedFact = { validOn: "2027-02-20", recordedAt: new Date("2027-02-20T10:00:00Z") };
const now = new Date("2027-03-01T09:00:00Z");
const pl = { type: "user", staffUserId: "pl-1" } as const;
const manager = { type: "user", staffUserId: "rom-1" } as const;
const requested: ProfilingException = {
  ...noProfilingException,
  status: "requested",
  reason: "force_majeure",
  requestedBy: "pl-1",
};

function op(extra: Partial<OperationContext> = {}): OperationContext {
  return { ...context({ actor: pl }), now, ...extra };
}
const fail = (code: string) => ({ ok: false, code });
const request = (extra: Partial<OperationContext>, req: Partial<ExceptionRequest> = {}) =>
  requestProfilingException(op(extra), noProfilingException, {
    reason: "force_majeure",
    evidence,
    ...req,
  });
const informedWith = (profilingStatus: "profiling_done" | "profiling_declined") => ({
  current: { ...context().current, profilingStatus },
});
const active = { current: { ...context().current, status: "active_in_tg" as const } };

describe("requesting a profiling exception (AC-6, Q81)", () => {
  it("needs a Q81 code and the evidence or BA reference", () => {
    expect(request({})).toEqual({ ok: true, next: requested });
    expect(request({}, { evidence: undefined })).toEqual(fail("evidence_missing"));
    expect(request({}, { evidence: { ...evidence, validOn: "2027-03-02" } })).toEqual(
      fail("evidence_missing"),
    );
    expect(request({}, { reason: "late_joiner" as never })).toEqual(fail("reason_invalid"));
  });

  it("ba_confirmed_other also needs who at the BA confirmed it, and when", () => {
    const other = { reason: "ba_confirmed_other" } as const;
    expect(request({}, other)).toEqual(fail("ba_confirmation_missing"));
    expect(request({}, { ...other, baConfirmation: evidence }).ok).toBe(true);
  });

  it.each([
    ["by the system", { actor: { type: "system" } }, "actor_not_allowed"],
    ["in ta_only", { projectType: "ta_only" }, "not_ta_tg"],
    ["before informed", { current: { ...context().current, status: "contacted" } }, "not_informed"],
    ["after TG entry", active, "not_informed"],
    ["after profiling_done", informedWith("profiling_done"), "profiling_closed"],
    ["after profiling_declined (Q74)", informedWith("profiling_declined"), "profiling_closed"],
  ] as const)("is refused %s", (_, extra, code) => {
    expect(request(extra)).toEqual(fail(code));
  });

  it("is refused while one is open; may follow a rejected or revoked one", () => {
    const req = { reason: "force_majeure", evidence } as const;
    for (const status of ["requested", "approved"] as const) {
      expect(requestProfilingException(op(), { ...requested, status }, req)).toEqual(
        fail("exception_open"),
      );
    }
    for (const status of ["rejected", "revoked"] as const) {
      expect(requestProfilingException(op(), { ...requested, status }, req)).toEqual({
        ok: true,
        next: requested,
      });
    }
  });
});

describe("deciding a profiling exception (AC-6, Q80)", () => {
  it("needs a decider who isn't the requester", () => {
    expect(decideProfilingException(op(), requested, "approve")).toEqual(fail("four_eyes"));
    expect(decideProfilingException(op(), { ...requested, requestedBy: null }, "approve")).toEqual(
      fail("four_eyes"),
    );
    const decided = { decidedBy: "rom-1", decidedOn: "2027-03-01", decidedAt: now };
    expect(decideProfilingException(op({ actor: manager }), requested, "approve")).toEqual({
      ok: true,
      next: { ...requested, status: "approved", ...decided },
    });
    expect(decideProfilingException(op({ actor: manager }), requested, "reject")).toEqual({
      ok: true,
      next: { ...requested, status: "rejected", ...decided },
    });
  });

  it.each([
    ["by the system", { actor: { type: "system" } }, requested, "actor_not_allowed"],
    ["without a request", { actor: manager }, noProfilingException, "not_requested"],
    ["after TG entry", { ...active, actor: manager }, requested, "not_informed"],
    [
      "after profiling_declined",
      { ...informedWith("profiling_declined"), actor: manager },
      requested,
      "profiling_closed",
    ],
  ] as const)("is refused %s", (_, extra, exception, code) => {
    expect(decideProfilingException(op(extra), exception, "approve")).toEqual(fail(code));
  });
});

function reconcile(exception: ProfilingException) {
  const facts = {
    dsvFullyExecuted: evidence,
    asuRegisteredWithProof: evidence,
    profilingExceptionApproved: approvedExceptionFact(exception),
  };
  const ctx = context({ entryKind: "reconciliation", today: "2027-04-10", facts });
  return canTransition("main", "informed", "active_in_tg", {
    ...ctx,
    current: { ...ctx.current, dsvStatus: "dsv_signed" },
  });
}

describe("an exception counts for entry only when approved, from its date (AC-6, round 9)", () => {
  const approved = { ...requested, status: "approved", decidedBy: "rom-1" } as const;
  const on = (decidedOn: string, decidedAt: Date): ProfilingException => ({
    ...approved,
    decidedOn,
    decidedAt,
  });

  it.each(["none", "requested", "rejected", "revoked"] as const)("%s gives no fact", (status) => {
    expect(approvedExceptionFact({ ...on("2027-03-01", now), status })).toBeUndefined();
  });

  it("an approval gives a fact valid from the decision", () => {
    expect(approvedExceptionFact(on("2027-03-01", now))).toEqual({
      validOn: "2027-03-01",
      recordedAt: now,
    });
    expect(
      approvedExceptionFact({ ...approved, decidedOn: null, decidedAt: null }),
    ).toBeUndefined();
  });

  it("an approval after the TG start doesn't allow entry (case 3)", () => {
    expect(reconcile(on("2027-03-01", now)).ok).toBe(true);
    const late = new Date("2027-04-05T09:00:00Z");
    expect(reconcile(on("2027-04-05", late))).toEqual({
      ok: false,
      code: "guard_failed",
      failedGuards: ["profiling_done_or_approved_exception"],
    });
  });
});

describe("revoking a profiling exception (AC-6, Q60)", () => {
  it.each(["requested", "approved"] as const)("revokes a %s one before entry", (status) => {
    expect(revokeProfilingException(op(), { ...requested, status })).toEqual({
      ok: true,
      next: { ...requested, status: "revoked" },
    });
  });

  it.each(["none", "rejected", "revoked"] as const)("has nothing to revoke when %s", (status) => {
    expect(revokeProfilingException(op(), { ...requested, status })).toEqual(fail("not_revocable"));
  });

  it("is refused after entry and for the system", () => {
    expect(revokeProfilingException(op(active), requested)).toEqual(fail("not_informed"));
    expect(revokeProfilingException(op({ actor: { type: "system" } }), requested)).toEqual(
      fail("actor_not_allowed"),
    );
  });
});
