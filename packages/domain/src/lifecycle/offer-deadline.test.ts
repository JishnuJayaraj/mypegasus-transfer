import { describe, expect, it } from "vitest";
import type { DsvStatus } from "./enums";
import type { DatedFact } from "./guards";
import { context, wave } from "./testing/context";
import { canTransition, type TransitionContext } from "./transition";
import {
  effectiveOfferDeadline,
  effectiveTgEnd,
  effectiveTgStart,
  projectFinalEntryDate,
} from "./waves";

// Fixture wave: signing deadline 2027-03-15, TG 2027-04-01 – 2028-03-31, latest entry 2027-04-30.
const generated: DatedFact = {
  validOn: "2027-02-20",
  recordedAt: new Date("2027-02-20T10:00:00Z"),
};
const failed = (...failedGuards: string[]) => ({ ok: false, code: "guard_failed", failedGuards });
const allowed = { ok: true, flagForReview: false };

function offer(from: DsvStatus, extra: Partial<TransitionContext> = {}) {
  const ctx = context({ facts: { dsvGenerated: generated }, ...extra });
  return canTransition("dsv", from, "dsv_offered", {
    ...ctx,
    current: { ...ctx.current, dsvStatus: from },
  });
}

describe("effective dates (plan 5.3)", () => {
  const own = { tgStart: "2027-05-01", tgEnd: "2027-12-31", offerDeadline: "2027-04-20" };
  const none = { tgStart: null, tgEnd: null, offerDeadline: null };

  it("prefer the participation's own dates over the wave defaults", () => {
    expect([effectiveTgStart(own, wave), effectiveTgEnd(own, wave)]).toEqual([
      "2027-05-01",
      "2027-12-31",
    ]);
    expect(effectiveOfferDeadline(own, wave)).toBe("2027-04-20");
    expect([effectiveTgStart(none, wave), effectiveTgEnd(none, wave)]).toEqual([
      "2027-04-01",
      "2028-03-31",
    ]);
    expect(effectiveOfferDeadline(none, wave)).toBe("2027-03-15");
  });

  it("are null without either (the system never invents a date)", () => {
    expect([effectiveTgStart(none, null), effectiveTgEnd(none, null)]).toEqual([null, null]);
    expect(effectiveOfferDeadline(none, null)).toBeNull();
  });

  it("derive the project's final entry date only when every wave has one (Q84, round 9)", () => {
    const later = { ...wave, id: "wave-2", latestEntryDate: "2027-06-30" };
    expect(projectFinalEntryDate([wave, later])).toBe("2027-06-30");
    expect(projectFinalEntryDate([later, wave])).toBe("2027-06-30");
    expect(projectFinalEntryDate([wave, { ...later, latestEntryDate: null }])).toBeNull();
    expect(projectFinalEntryDate([])).toBeNull();
  });
});

describe("waves and offers (AC-7, Q69, Q79)", () => {
  it("the first offer needs a wave and uses its signing deadline", () => {
    expect(offer("not_offered")).toEqual(allowed);
    expect(offer("not_offered", { wave: null })).toEqual(
      failed("entry_wave_assigned", "offer_deadline_valid"),
    );
    expect(offer("not_offered", { facts: {} })).toEqual(failed("dsv_generated"));
    expect(offer("not_offered", { today: "2027-03-16" })).toEqual(failed("offer_deadline_valid"));
  });

  it("can't be recorded without any deadline", () => {
    const noDeadline = { wave: { ...wave, signingDeadline: null } };
    expect(offer("not_offered", noDeadline)).toEqual(failed("offer_deadline_valid"));
    expect(offer("not_offered", { ...noDeadline, newOfferDeadline: "2027-03-20" })).toEqual(
      allowed,
    );
  });

  it.each([
    ["today (inclusive)", "2027-03-01", {}, true],
    ["yesterday", "2027-02-28", {}, false],
    ["the planned TG start", "2027-04-01", {}, true],
    ["after the planned TG start", "2027-04-02", {}, false],
    ["the latest entry date", "2027-04-30", { tgStart: "2027-05-15" }, true],
    ["after the latest entry date", "2027-05-01", { tgStart: "2027-05-15" }, false],
  ] as const)("an explicit deadline on %s: %s", (_, newOfferDeadline, own, ok) => {
    const participation = { tgStart: null, offerDeadline: null, ...own };
    expect(offer("not_offered", { newOfferDeadline, participation }).ok).toBe(ok);
  });

  it("fails closed when the wave has no latest entry date or there's no TG start", () => {
    expect(offer("not_offered", { wave: { ...wave, latestEntryDate: null } })).toEqual(
      failed("offer_deadline_valid"),
    );
    expect(offer("not_offered", { wave: { ...wave, defaultTgStart: null } })).toEqual(
      failed("offer_deadline_valid"),
    );
  });

  it.each(["dsv_declined", "dsv_expired"] as const)(
    "a re-offer from %s needs an explicit deadline and the cutoff not passed",
    (from) => {
      expect(offer(from)).toEqual(failed("offer_deadline_valid"));
      expect(offer(from, { newOfferDeadline: "2027-03-20" })).toEqual(allowed);
      expect(offer(from, { today: "2027-05-01", newOfferDeadline: "2027-05-02" })).toEqual(
        failed("before_cutoff", "offer_deadline_valid"),
      );
    },
  );
});

function recontact(extra: Partial<TransitionContext>) {
  const ctx = context(extra);
  const current = { ...ctx.current, status: "unreachable" as const };
  return canTransition("main", "unreachable", "contacted", { ...ctx, current });
}

describe("before_cutoff on the return arrows (Q77)", () => {
  it("is open through the latest entry date and closes the next day", () => {
    expect(recontact({ today: "2027-04-30" })).toEqual(allowed);
    expect(recontact({ today: "2027-05-01" })).toEqual(failed("before_cutoff"));
  });

  it("passes without a wave or without a latest entry date", () => {
    expect(recontact({ today: "2027-05-01", wave: null })).toEqual(allowed);
    expect(recontact({ today: "2027-05-01", wave: { ...wave, latestEntryDate: null } })).toEqual(
      allowed,
    );
  });

  it("also guards a change of mind on profiling", () => {
    const ctx = context({ today: "2027-05-01" });
    const current = { ...ctx.current, profilingStatus: "profiling_declined" as const };
    expect(
      canTransition("profiling", "profiling_declined", "profiling_accepted", { ...ctx, current }),
    ).toEqual(failed("before_cutoff"));
  });
});
