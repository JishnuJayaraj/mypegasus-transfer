import { describe, expect, it } from "vitest";
import {
  checkWaveChange,
  CreateEntryWaveInput,
  UpdateEntryWaveInput,
  type WaveChange,
  type WaveValues,
} from "./waves";

// AC-5 (Slice 2 plan 5.6, R4, R25, Q101 fail safe): one expected result per rule, at the boundary
// days. Today is 2027-01-15 throughout.
const today = "2027-01-15";

const wave: WaveValues = {
  code: "W1",
  name: "Welle 1",
  signingDeadline: "2027-02-15",
  defaultTgStart: "2027-03-01",
  defaultTgEnd: "2028-02-29",
  latestEntryDate: "2027-03-15",
};
const unused = { participations: 0, openFirstOffers: 0, reliesOnDefaultStart: false };
const used = { participations: 3, openFirstOffers: 0, reliesOnDefaultStart: false };

const check = (change: Partial<WaveChange>) =>
  checkWaveChange({
    project: { type: "ta_tg", status: "draft" },
    before: null,
    after: wave,
    usage: unused,
    otherWaves: [],
    today,
    ...change,
  });
const codes = (change: Partial<WaveChange>) => check(change).map((issue) => issue.code);
const edit = (before: Partial<WaveValues>, after: Partial<WaveValues>) => ({
  before: { ...wave, ...before },
  after: { ...wave, ...before, ...after },
});

describe("checkWaveChange (plan 5.6)", () => {
  it("accepts a new wave, a wave without dates and an edit of its name", () => {
    expect(check({})).toEqual([]);
    const empty = {
      signingDeadline: null,
      defaultTgStart: null,
      defaultTgEnd: null,
      latestEntryDate: null,
    };
    expect(check({ after: { ...wave, ...empty } })).toEqual([]);
    expect(check({ ...edit({}, { name: "Welle eins" }), usage: used })).toEqual([]);
  });

  it("allows waves only in ta_tg projects, and says only that", () => {
    expect(
      check({ project: { type: "ta_only", status: "draft" }, after: { ...wave, code: "" } }),
    ).toEqual([{ code: "not_ta_tg", field: null }]);
  });

  it.each([
    ["an empty code", { code: "" }, "invalid_code"],
    ["a 21-character code", { code: "W".repeat(21) }, "invalid_code"],
    ["a code with a space", { code: "W 1" }, "invalid_code"],
    ["an empty name", { name: "" }, "invalid_name"],
    ["a 101-character name", { name: "x".repeat(101) }, "invalid_name"],
    ["an untrimmed name", { name: " Welle" }, "invalid_name"],
    ["a name with a control character", { name: "Welle\u00071" }, "invalid_name"],
  ])("refuses %s", (_label, values, code) => {
    expect(codes({ after: { ...wave, ...values } })).toEqual([code]);
  });

  it("accepts the longest code and name", () => {
    expect(check({ after: { ...wave, code: "A-b_9".repeat(4), name: "ä".repeat(100) } })).toEqual(
      [],
    );
  });

  it("refuses a code another wave of the project has, never its own", () => {
    const otherWaves = [{ code: "W2", latestEntryDate: null }];
    expect(check({ after: { ...wave, code: "W2" }, otherWaves })).toEqual([
      { code: "code_taken", field: "code" },
    ]);
    expect(check({ ...edit({}, { name: "X" }), otherWaves })).toEqual([]);
  });

  it.each([
    // [label, dates, issues] — every bound is inclusive
    ["signing deadline on the start day", { signingDeadline: "2027-03-01" }, []],
    [
      "signing deadline after the start",
      { signingDeadline: "2027-03-02" },
      [{ code: "signing_after_start", field: "signingDeadline" }],
    ],
    [
      "signing deadline after the latest entry",
      { signingDeadline: "2027-03-16", defaultTgStart: null },
      [{ code: "signing_after_latest_entry", field: "signingDeadline" }],
    ],
    ["start on the latest entry day", { defaultTgStart: "2027-03-15" }, []],
    [
      "start after the latest entry",
      { defaultTgStart: "2027-03-16", defaultTgEnd: "2028-03-15" },
      [{ code: "start_after_latest_entry", field: "defaultTgStart" }],
    ],
    ["end on the start day", { defaultTgEnd: "2027-03-01" }, []],
    [
      "end before the start",
      { defaultTgEnd: "2027-02-28" },
      [{ code: "end_before_start", field: "defaultTgEnd" }],
    ],
    // R25: at most addMonths(start, 12) − 1 day, month ends clamped.
    ["exactly twelve months", { defaultTgEnd: "2028-02-29" }, []],
    [
      "twelve months and a day",
      { defaultTgEnd: "2028-03-01" },
      [{ code: "period_exceeds_twelve_months", field: "defaultTgEnd" }],
    ],
    [
      "twelve months from a month end",
      { defaultTgStart: "2027-01-31", defaultTgEnd: "2028-01-30", signingDeadline: null },
      [],
    ],
    [
      "twelve months and a day from a month end",
      { defaultTgStart: "2027-01-31", defaultTgEnd: "2028-01-31", signingDeadline: null },
      [{ code: "period_exceeds_twelve_months", field: "defaultTgEnd" }],
    ],
    [
      "twelve months from a leap day",
      {
        defaultTgStart: "2028-02-29",
        defaultTgEnd: "2029-02-27",
        latestEntryDate: "2028-03-15",
        signingDeadline: null,
      },
      [],
    ],
    [
      "twelve months and a day from a leap day",
      {
        defaultTgStart: "2028-02-29",
        defaultTgEnd: "2029-02-28",
        latestEntryDate: "2028-03-15",
        signingDeadline: null,
      },
      [{ code: "period_exceeds_twelve_months", field: "defaultTgEnd" }],
    ],
  ] as const)("ordering: %s", (_label, dates, issues) => {
    expect(check({ after: { ...wave, ...dates } })).toEqual(issues);
  });

  it("checks only the dates that are set", () => {
    const values = { signingDeadline: "2027-12-31", defaultTgStart: null, latestEntryDate: null };
    expect(check({ after: { ...wave, ...values } })).toEqual([]);
  });

  describe("no retroactive cutoff", () => {
    it("sets a latest entry date today at the earliest", () => {
      const dates = { signingDeadline: null, defaultTgStart: null };
      expect(check({ after: { ...wave, ...dates, latestEntryDate: today } })).toEqual([]);
      expect(check({ after: { ...wave, ...dates, latestEntryDate: "2027-01-14" } })).toEqual([
        { code: "latest_entry_in_past", field: "latestEntryDate" },
      ]);
      expect(
        codes(edit({ ...dates, latestEntryDate: null }, { latestEntryDate: "2027-01-14" })),
      ).toEqual(["latest_entry_in_past"]);
    });

    it("keeps a passed cutoff, and allows editing other fields of that wave", () => {
      const passed = {
        signingDeadline: "2026-12-01",
        defaultTgStart: "2027-01-01",
        defaultTgEnd: "2027-12-31",
        latestEntryDate: "2027-01-14",
      };
      expect(check(edit(passed, { name: "Welle alt" }))).toEqual([]);
      expect(check(edit(passed, { latestEntryDate: "2027-02-01" }))).toEqual([
        { code: "cutoff_passed", field: "latestEntryDate" },
      ]);
      // On the latest entry day itself the cutoff hasn't passed yet.
      expect(
        check(edit({ ...passed, latestEntryDate: today }, { latestEntryDate: "2027-02-01" })),
      ).toEqual([]);
    });
  });

  it("keeps the signing deadline while first offers of the wave are open", () => {
    const offers = { ...used, openFirstOffers: 1 };
    expect(check({ ...edit({}, { signingDeadline: "2027-02-20" }), usage: offers })).toEqual([
      { code: "signing_deadline_in_use", field: "signingDeadline" },
    ]);
    expect(check({ ...edit({}, { signingDeadline: "2027-02-20" }), usage: used })).toEqual([]);
    expect(check({ ...edit({}, { name: "X" }), usage: offers })).toEqual([]);
  });

  describe("the default TG start", () => {
    const relying = { ...used, reliesOnDefaultStart: true };

    it("doesn't change once reached (R29: on the start day the due run may enter)", () => {
      const reached = {
        signingDeadline: "2027-01-01",
        defaultTgStart: today,
        defaultTgEnd: "2027-12-31",
      };
      expect(check(edit(reached, { defaultTgStart: "2027-01-20" }))).toEqual([
        { code: "default_start_passed", field: "defaultTgStart" },
      ]);
      expect(
        check(edit({ ...reached, defaultTgStart: "2027-01-16" }, { defaultTgStart: "2027-01-20" })),
      ).toEqual([]);
    });

    it("moves to today at the earliest while participations rely on it", () => {
      const before = {
        signingDeadline: "2027-01-10",
        defaultTgStart: "2027-02-01",
        defaultTgEnd: "2027-12-31",
      };
      expect(check({ ...edit(before, { defaultTgStart: "2027-01-14" }), usage: relying })).toEqual([
        { code: "default_start_in_past", field: "defaultTgStart" },
      ]);
      expect(check({ ...edit(before, { defaultTgStart: today }), usage: relying })).toEqual([]);
      // Nobody relies on it: the past start is only a date.
      expect(check({ ...edit(before, { defaultTgStart: "2027-01-14" }), usage: used })).toEqual([]);
    });
  });

  describe("clearing dates", () => {
    const cleared = {
      signingDeadline: null,
      defaultTgStart: null,
      defaultTgEnd: null,
      latestEntryDate: null,
    };

    it("clears dates only while the wave has no participation", () => {
      expect(check(edit({}, cleared))).toEqual([]);
      expect(check({ ...edit({}, cleared), usage: used })).toEqual([
        { code: "date_in_use", field: "signingDeadline" },
        { code: "date_in_use", field: "defaultTgStart" },
        { code: "date_in_use", field: "defaultTgEnd" },
        { code: "date_in_use", field: "latestEntryDate" },
      ]);
    });

    it("never clears the last latest entry date of an active project", () => {
      const active = { type: "ta_tg", status: "active" } as const;
      const clear = edit({}, { latestEntryDate: null });
      expect(check({ ...clear, project: active })).toEqual([
        { code: "last_latest_entry_date", field: "latestEntryDate" },
      ]);
      const others = [{ code: "W2", latestEntryDate: null }];
      expect(codes({ ...clear, project: active, otherWaves: others })).toEqual([
        "last_latest_entry_date",
      ]);
      expect(
        check({ ...clear, project: active, otherWaves: [{ code: "W2", latestEntryDate: today }] }),
      ).toEqual([]);
      expect(check(clear)).toEqual([]);
    });
  });

  it("reports every issue at once", () => {
    expect(
      codes({
        after: {
          ...wave,
          code: "",
          name: "",
          signingDeadline: "2027-04-01",
          latestEntryDate: "2027-01-01",
        },
      }),
    ).toEqual([
      "invalid_code",
      "invalid_name",
      "signing_after_start",
      "signing_after_latest_entry",
      "start_after_latest_entry",
      "latest_entry_in_past",
    ]);
  });
});

describe("the wave inputs", () => {
  it("trims code and name, takes dates or null, and is strict", () => {
    expect(CreateEntryWaveInput.parse({ code: " W3 ", name: " Welle 3 " })).toEqual({
      code: "W3",
      name: "Welle 3",
    });
    expect(
      CreateEntryWaveInput.safeParse({ code: "W3", name: "x", latestEntryDate: "2027-02-30" })
        .success,
    ).toBe(false);
    expect(CreateEntryWaveInput.safeParse({ code: "W3", name: "x", note: "y" }).success).toBe(
      false,
    );
  });

  it("changes at least one field; null clears a date", () => {
    expect(UpdateEntryWaveInput.parse({ latestEntryDate: null })).toEqual({
      latestEntryDate: null,
    });
    expect(UpdateEntryWaveInput.safeParse({}).error?.issues[0]).toMatchObject({
      params: { code: "nothing_to_change" },
    });
    expect(UpdateEntryWaveInput.safeParse({ projectId: "x" }).success).toBe(false);
  });
});
