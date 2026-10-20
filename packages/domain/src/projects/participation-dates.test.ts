import { describe, expect, it } from "vitest";
import type { EntryWave } from "../lifecycle/waves";
import {
  checkParticipationDates,
  ParticipationDatesInput,
  type DatesCheckInput,
} from "./participation-dates";

// Slice 2 plan 5.7 (PR 2h-3; rounds 32–34; AC-36, AC-47): individual TG dates, the new start
// date, DSV amendments and the BA reporting kinds. One expected result per rule, at its boundary.

const wave: EntryWave = {
  id: "wave-1",
  code: "W1",
  signingDeadline: "2027-03-15",
  defaultTgStart: "2027-04-01",
  defaultTgEnd: "2028-03-31",
  latestEntryDate: "2027-04-30",
};
const base: DatesCheckInput = {
  projectType: "ta_tg",
  status: "informed",
  dsvStatus: "not_offered",
  wave,
  participation: { tgStart: null, tgEnd: null, offerDeadline: null },
  oldEmploymentEndDate: "2027-03-31",
  change: { tgStart: null, tgEnd: null },
  amendment: null,
  today: "2027-03-01",
  entryRunCompletedToday: false,
};
/** A new start with the former employment ending exactly the day before (direct). */
const start = (tgStart: string, extra: Partial<DatesCheckInput> = {}): DatesCheckInput => ({
  ...base,
  oldEmploymentEndDate: dayBefore(tgStart),
  ...extra,
  change: { tgStart, tgEnd: null, ...extra.change },
});
const end = (tgEnd: string, extra: Partial<DatesCheckInput> = {}): DatesCheckInput => ({
  ...base,
  ...extra,
  change: { tgStart: null, tgEnd, ...extra.change },
});
function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const codes = (input: DatesCheckInput) => {
  const result = checkParticipationDates(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};
const signed = { dsvStatus: "dsv_signed" as const };
const amendment = (fullyExecutedOn: string, confirmed = true) => ({ fullyExecutedOn, confirmed });

describe("checkParticipationDates: preconditions (5.7)", () => {
  it("is for ta_tg participations with a wave that has a latest entry date", () => {
    expect(codes(end("2028-02-29", { projectType: "ta_only" }))).toEqual(["not_ta_tg"]);
    expect(codes(end("2028-02-29", { wave: null }))).toEqual(["wave_required"]);
    expect(codes(end("2028-02-29", { wave: { ...wave, latestEntryDate: null } }))).toEqual([
      "latest_entry_date_missing",
    ]);
  });

  it.each(["withdrawn", "rejected", "exited", "ta_completed"] as const)(
    "refuses a closed participation (%s)",
    (status) => {
      expect(codes(end("2028-02-29", { status }))).toEqual(["participation_closed"]);
    },
  );

  it("refuses any change while a DSV offer is open (R35)", () => {
    expect(codes(end("2028-02-29", { dsvStatus: "dsv_offered" }))).toEqual(["dsv_offer_open"]);
  });

  it("refuses a change of no effective date (round 16 style)", () => {
    expect(codes(base)).toEqual(["dates_unchanged"]);
    // The wave's own date set individually is no change either.
    expect(codes(start("2027-04-01"))).toEqual(["dates_unchanged"]);
  });
});

/** A new start on 15.04.2027 with the former employment ending on the given day. */
const endingOn = (oldEmploymentEndDate: string | null) =>
  codes({ ...start("2027-04-15"), oldEmploymentEndDate });
/** A start with an end within twelve months of it (for starts earlier than the wave's). */
const early = (tgStart: string, extra: Partial<DatesCheckInput> = {}, tgEnd = "2028-02-27") =>
  codes(start(tgStart, { ...extra, change: { tgStart, tgEnd } }));

describe("the start (5.7, L6, R34, R37; round 33)", () => {
  it("accepts a later start within the wave, with the transition direct", () => {
    expect(checkParticipationDates(start("2027-04-15"))).toEqual({
      ok: true,
      effective: { tgStart: "2027-04-15", tgEnd: "2028-03-31" },
      startChanged: true,
      endChanged: false,
      amendmentKind: null,
      reportingKinds: ["later_entry"],
    });
  });

  it("is never in the past, and not today once today's entry run completed", () => {
    expect(early("2027-02-28")).toEqual(["start_in_past"]);
    expect(early("2027-03-01")).toEqual([]);
    expect(early("2027-03-01", { entryRunCompletedToday: true })).toEqual([
      "start_today_after_entry_run",
    ]);
    expect(early("2027-03-02", { entryRunCompletedToday: true })).toEqual([]);
  });

  it("is not after the wave's latest entry date", () => {
    expect(codes(start("2027-04-30"))).toEqual([]);
    expect(codes(start("2027-05-01"))).toEqual(["start_after_latest_entry"]);
  });

  it("is not before the participation's own offer deadline (re-offer)", () => {
    const own = {
      dsvStatus: "dsv_expired" as const,
      participation: { tgStart: null, tgEnd: null, offerDeadline: "2027-03-20" },
    };
    const at = (tgStart: string) => early(tgStart, { ...own }, "2028-03-18");
    expect(at("2027-03-19")).toEqual(["start_before_offer_deadline"]);
    expect(at("2027-03-20")).toEqual([]);
  });

  it("needs the former employment to end exactly the day before (round 33)", () => {
    expect(endingOn("2027-04-14")).toEqual([]);
    expect(endingOn("2027-04-13")).toEqual(["ba_review_required"]);
    expect(endingOn("2027-04-15")).toEqual(["employment_overlap"]);
    expect(endingOn(null)).toEqual(["old_employment_end_unknown"]);
  });

  it("doesn't change after TG entry", () => {
    expect(codes(start("2027-04-15", { status: "active_in_tg", ...signed }))).toEqual([
      "entered",
      "dsv_amendment_required",
    ]);
  });

  it("can't return to a wave without a default start", () => {
    const own = {
      wave: { ...wave, defaultTgStart: null },
      participation: { tgStart: "2027-04-10", tgEnd: null, offerDeadline: null },
    };
    expect(codes({ ...base, ...own, change: { tgStart: null, tgEnd: null } })).toEqual([
      "start_missing",
    ]);
  });
});

describe("the end (5.7, L3, R36)", () => {
  it("may move either way before the DSV is signed", () => {
    expect(checkParticipationDates(end("2028-02-29"))).toMatchObject({
      ok: true,
      endChanged: true,
      amendmentKind: null,
      reportingKinds: ["planned_end_changed"],
    });
  });

  it("is never in the past, never before the start, and can't be cleared to nothing", () => {
    expect(codes(end("2027-02-28"))).toEqual(["end_in_past", "end_before_start"]);
    expect(codes(end("2027-03-31"))).toEqual(["end_before_start"]);
    expect(codes(end("2027-04-01"))).toEqual([]);
    const own = {
      wave: { ...wave, defaultTgEnd: null },
      participation: { tgStart: null, tgEnd: "2028-01-31", offerDeadline: null },
    };
    expect(codes({ ...base, ...own, change: { tgStart: null, tgEnd: null } })).toEqual([
      "end_missing",
    ]);
  });

  it("keeps the effective period within twelve months (an MVP support limit, L2)", () => {
    expect(codes(end("2028-03-31"))).toEqual(["dates_unchanged"]);
    expect(codes(end("2028-04-01"))).toEqual(["period_exceeds_twelve_months"]);
    // Month ends: from 29.02. twelve months end on 27.02. of the next year.
    const leap = start("2028-02-29", {
      today: "2028-01-10",
      wave: { ...wave, defaultTgStart: "2028-03-01", latestEntryDate: "2028-03-15" },
    });
    expect(codes({ ...leap, change: { tgStart: "2028-02-29", tgEnd: "2029-02-27" } })).toEqual([]);
    expect(codes({ ...leap, change: { tgStart: "2028-02-29", tgEnd: "2029-02-28" } })).toEqual([
      "period_exceeds_twelve_months",
    ]);
  });
});

describe("once the DSV is signed: the amendment (R34, R36, R41; L3–L6)", () => {
  it("needs a fully executed amendment for every change", () => {
    expect(codes(end("2028-02-29", signed))).toEqual([
      "end_not_extension",
      "dsv_amendment_required",
    ]);
    expect(codes(start("2027-04-15", signed))).toEqual(["dsv_amendment_required"]);
  });

  it("only extends the end, before entry too", () => {
    const shorter = end("2028-02-29", { ...signed, amendment: amendment("2027-03-01") });
    expect(codes(shorter)).toEqual(["end_not_extension"]);
    const later = {
      ...signed,
      participation: { tgStart: null, tgEnd: "2028-01-31", offerDeadline: null },
    };
    expect(
      checkParticipationDates(end("2028-03-31", { ...later, amendment: amendment("2027-03-01") })),
    ).toMatchObject({
      ok: true,
      amendmentKind: "extension",
      reportingKinds: ["planned_end_changed"],
    });
  });

  it("extends after entry, the amendment executed on or before the current end", () => {
    const entered = {
      status: "active_in_tg" as const,
      ...signed,
      today: "2028-01-10",
      participation: { tgStart: null, tgEnd: "2028-01-31", offerDeadline: null },
    };
    expect(codes(end("2028-03-31", { ...entered, amendment: amendment("2028-01-10") }))).toEqual(
      [],
    );
    expect(codes(end("2028-03-31", { ...entered, amendment: amendment("2028-01-11") }))).toEqual([
      "amendment_not_executed_in_time",
    ]);
    const lastDay = { ...entered, today: "2028-01-31" };
    expect(codes(end("2028-03-31", { ...lastDay, amendment: amendment("2028-01-31") }))).toEqual(
      [],
    );
    expect(codes(end("2028-03-31", { ...lastDay, amendment: amendment("2028-02-01") }))).toEqual([
      "amendment_not_executed_in_time",
    ]);
  });

  it("executes a new start's amendment before the new start", () => {
    const missed = { ...signed, today: "2027-04-10" };
    expect(
      checkParticipationDates(
        start("2027-04-15", { ...missed, amendment: amendment("2027-04-10") }),
      ),
    ).toMatchObject({ ok: true, amendmentKind: "new_start", reportingKinds: ["later_entry"] });
    expect(codes(start("2027-04-11", { ...missed, amendment: amendment("2027-04-10") }))).toEqual(
      [],
    );
    expect(codes(start("2027-04-10", { ...missed, amendment: amendment("2027-04-10") }))).toEqual([
      "amendment_not_executed_in_time",
    ]);
  });

  it("is confirmed by the PL and not dated after today", () => {
    expect(
      codes(start("2027-04-15", { ...signed, amendment: amendment("2027-03-01", false) })),
    ).toEqual(["amendment_unconfirmed"]);
    expect(codes(start("2027-04-15", { ...signed, amendment: amendment("2027-03-02") }))).toEqual([
      "amendment_not_executed_in_time",
    ]);
  });

  it("is refused before the DSV is signed: there is nothing to amend", () => {
    expect(codes(start("2027-04-15", { amendment: amendment("2027-03-01") }))).toEqual([
      "amendment_not_allowed",
    ]);
  });

  it("reports both kinds for a change of both dates, as one new-start amendment", () => {
    const both = start("2027-04-15", {
      ...signed,
      amendment: amendment("2027-03-01"),
      change: { tgStart: "2027-04-15", tgEnd: "2028-04-14" },
    });
    expect(checkParticipationDates(both)).toMatchObject({
      ok: true,
      startChanged: true,
      endChanged: true,
      amendmentKind: "new_start",
      reportingKinds: ["later_entry", "planned_end_changed"],
    });
  });
});

describe("ParticipationDatesInput", () => {
  it("takes both dates, the expected version and an optional amendment of codes and dates", () => {
    const valid = {
      tgStart: null,
      tgEnd: "2028-02-29",
      expectedVersion: 3,
      amendment: {
        fullyExecutedOn: "2027-03-01",
        originalLocation: "paper_personnel_file",
        documentReference: "DSV-2027/0001",
        originalInspected: true,
        allPartiesSigned: true,
        retrievable: true,
      },
    };
    expect(ParticipationDatesInput.safeParse(valid).success).toBe(true);
    expect(
      ParticipationDatesInput.safeParse({
        ...valid,
        amendment: { ...valid.amendment, documentReference: "siehe Telefonat mit Frau X" },
      }).success,
    ).toBe(false);
    expect(
      ParticipationDatesInput.safeParse({
        ...valid,
        amendment: { ...valid.amendment, originalLocation: "desk" },
      }).success,
    ).toBe(false);
  });
});
