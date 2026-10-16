import { describe, expect, it } from "vitest";
import type { MainStatus, ProfilingStatus } from "./enums";
import type { DatedFact } from "./guards";
import {
  approvedExceptionFact,
  decideProfilingException,
  requestProfilingException,
  revokeProfilingException,
  supersedeStaleException,
  type EvidenceFact,
  type ExceptionRequest,
  type OperationContext,
  type ProfilingException,
} from "./operations";
import { context } from "./testing/context";
import { canTransition } from "./transition";

// Fixture: informed, ta_tg, today 2027-03-01, wave default TG start 2027-04-01.
const fact: DatedFact = { validOn: "2027-02-20", recordedAt: new Date("2027-02-20T10:00:00Z") };
const digest = (c: string) => `sha256:v1:${c.repeat(64)}`;
const evidence: EvidenceFact = { ...fact, recordId: "record-1", fingerprint: digest("a") };
const now = new Date("2027-03-01T09:00:00Z");
const pl = { type: "user", staffUserId: "pl-1" } as const;
const manager = { type: "user", staffUserId: "rom-1" } as const;
const system = { type: "system" } as const;
const requested: ProfilingException = {
  status: "requested",
  reason: "force_majeure",
  evidenceRecordId: "record-1",
  evidenceFingerprint: digest("a"),
  requestedBy: "pl-1",
  decidedBy: null,
  decidedOn: null,
  decidedAt: null,
  supersededBecause: null,
};

function op(extra: Partial<OperationContext> = {}): OperationContext {
  return { ...context({ actor: pl }), now, ...extra };
}
const fail = (code: string) => ({ ok: false, code });
const request = (
  extra: Partial<OperationContext>,
  req: Partial<ExceptionRequest> = {},
  latest: ProfilingException | null = null,
) => requestProfilingException(op(extra), latest, { reason: "force_majeure", evidence, ...req });
const at = (status: MainStatus, profilingStatus: ProfilingStatus = "not_started") => ({
  current: { status, profilingStatus, dsvStatus: "not_offered" as const },
});
const startOn = (tgStart: string) => ({ participation: { tgStart, offerDeadline: null } });

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
    expect(request({}, { ...other, baConfirmation: fact }).ok).toBe(true);
  });

  it.each([
    ["by the system", { actor: system }, "actor_not_allowed"],
    ["in ta_only", { projectType: "ta_only" }, "not_ta_tg"],
    ["before informed", at("contacted"), "not_informed"],
    ["after TG entry", at("active_in_tg"), "not_informed"],
    ["after profiling_done", at("informed", "profiling_done"), "profiling_closed"],
    ["after profiling_declined (Q74)", at("informed", "profiling_declined"), "profiling_closed"],
    ["without a TG start", { wave: null }, "no_future_start"],
    ["on the TG start day", startOn("2027-03-01"), "no_future_start"],
  ] as const)("is refused %s", (_, extra, code) => {
    expect(request(extra)).toEqual(fail(code));
  });

  it("is refused while a request or approval is open", () => {
    for (const status of ["requested", "approved"] as const) {
      expect(request({}, {}, { ...requested, status })).toEqual(fail("exception_open"));
    }
  });

  it.each(["rejected", "revoked", "superseded"] as const)(
    "after a %s one, is a new record that needs changed evidence (round 10)",
    (status) => {
      const previous = { ...requested, status, decidedBy: "rom-1" };
      expect(request({}, {}, previous)).toEqual(fail("evidence_unchanged"));
      // A new evidence record with the same canonical fingerprint is not changed evidence (Q94).
      const sameFacts = { ...evidence, recordId: "record-2" };
      expect(request({}, { evidence: sameFacts }, previous)).toEqual(fail("evidence_unchanged"));
      const corrected = { ...evidence, recordId: "record-3", fingerprint: digest("b") };
      expect(request({}, { evidence: corrected }, previous)).toEqual({
        ok: true,
        next: { ...requested, evidenceRecordId: "record-3", evidenceFingerprint: digest("b") },
      });
    },
  );
});

describe("deciding a profiling exception (AC-6, Q80)", () => {
  const decided = { decidedBy: "rom-1", decidedOn: "2027-03-01", decidedAt: now };

  it("needs a decider who isn't the requester", () => {
    expect(decideProfilingException(op(), requested, "approve")).toEqual(fail("four_eyes"));
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
    ["by the system", { actor: system }, requested, "actor_not_allowed"],
    [
      "for a closed request",
      { actor: manager },
      { ...requested, status: "revoked" },
      "not_requested",
    ],
    ["after TG entry", { ...at("active_in_tg"), actor: manager }, requested, "not_informed"],
    [
      "after profiling_declined",
      { ...at("informed", "profiling_declined"), actor: manager },
      requested,
      "profiling_closed",
    ],
    [
      "once the start has passed",
      { ...startOn("2027-02-28"), actor: manager },
      requested,
      "no_future_start",
    ],
  ] as const)("is refused %s", (_, extra, exception, code) => {
    expect(decideProfilingException(op(extra), exception, "approve")).toEqual(fail(code));
    expect(decideProfilingException(op(extra), exception, "reject")).toEqual(fail(code));
  });
});

function reconcile(exception: ProfilingException) {
  const facts = {
    dsvFullyExecuted: fact,
    asuRegisteredWithProof: fact,
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

  it.each(["requested", "rejected", "revoked", "superseded"] as const)(
    "%s gives no fact",
    (status) => {
      expect(approvedExceptionFact({ ...on("2027-03-01", now), status })).toBeUndefined();
    },
  );

  it("an approval gives a fact valid from the decision", () => {
    expect(approvedExceptionFact(null)).toBeUndefined();
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

  it.each(["rejected", "revoked", "superseded"] as const)(
    "has nothing to revoke when %s",
    (status) => {
      expect(revokeProfilingException(op(), { ...requested, status })).toEqual(
        fail("not_revocable"),
      );
    },
  );

  it("is refused for the system, once it no longer applies and after entry", () => {
    expect(revokeProfilingException(op({ actor: system }), requested)).toEqual(
      fail("actor_not_allowed"),
    );
    expect(revokeProfilingException(op(at("informed", "profiling_done")), requested)).toEqual(
      fail("no_longer_applicable"),
    );
    expect(revokeProfilingException(op(at("active_in_tg")), requested)).toEqual(
      fail("not_informed"),
    );
  });
});

describe("superseding a stale request (round 10)", () => {
  it.each([
    ["the participation closes", at("withdrawn"), "participation_closed"],
    ["the project becomes ta_only", { projectType: "ta_only" }, "project_ta_only"],
    ["profiling is done", at("informed", "profiling_done"), "profiling_closed"],
    ["profiling is declined", at("informed", "profiling_declined"), "profiling_closed"],
  ] as const)("closes a pending request when %s", (_, extra, because) => {
    expect(supersedeStaleException(op({ ...extra, actor: system }), requested)).toEqual({
      ok: true,
      next: { ...requested, status: "superseded", supersededBecause: because },
    });
  });

  it("leaves an applicable request, and every non-pending one, as it is", () => {
    expect(supersedeStaleException(op(), requested)).toEqual(fail("still_applicable"));
    // A passed start alone doesn't close it; it can't be approved for the missed date.
    expect(supersedeStaleException(op(startOn("2027-02-28")), requested)).toEqual(
      fail("still_applicable"),
    );
    for (const status of ["approved", "rejected", "revoked", "superseded"] as const) {
      expect(supersedeStaleException(op(at("withdrawn")), { ...requested, status })).toEqual(
        fail("not_pending"),
      );
    }
  });
});
