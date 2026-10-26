import { describe, expect, it } from "vitest";
import {
  assessmentFieldKeys,
  emptyAssessment,
  parseProfilingAssessment,
  ProfilingAssessment,
  ProfilingDeclarationsInput,
  ProfilingSessionsInput,
  profilingSessionsProblems,
  UnemploymentPeriodInput,
  type ProfilingSessionInput,
} from "./record";

const today = "2091-03-10";
const session = (date: string, from: string, to: string, id?: string): ProfilingSessionInput => ({
  ...(id && { id }),
  date,
  from,
  to,
});
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe("profiling sessions (Q193)", () => {
  it("accepts sessions on past days and today, touching ends on one day", () => {
    expect(
      profilingSessionsProblems(
        [
          session("2091-02-20", "09:00", "10:30", id(1)),
          session("2091-02-20", "10:30", "12:00"),
          session(today, "00:00", "23:59"),
        ],
        today,
      ),
    ).toEqual([]);
  });

  it("refuses bis not after von, equal included", () => {
    expect(
      profilingSessionsProblems(
        [session("2091-02-20", "10:00", "09:00"), session("2091-02-21", "10:00", "10:00")],
        today,
      ),
    ).toEqual([
      { code: "session_times_reversed", path: [0, "to"] },
      { code: "session_times_reversed", path: [1, "to"] },
    ]);
  });

  it("refuses a date after today", () => {
    expect(profilingSessionsProblems([session("2091-03-11", "09:00", "10:00")], today)).toEqual([
      { code: "session_in_future", path: [0, "date"] },
    ]);
  });

  it("refuses overlapping sessions of one day at the later one, not of different days", () => {
    expect(
      profilingSessionsProblems(
        [
          session("2091-02-20", "09:00", "11:00"),
          session("2091-02-21", "09:30", "10:00"),
          session("2091-02-20", "10:59", "12:00"),
          session("2091-02-20", "08:00", "09:01"),
        ],
        today,
      ),
    ).toEqual([
      { code: "sessions_overlap", path: [2] },
      { code: "sessions_overlap", path: [3] },
    ]);
  });

  it("refuses an id twice", () => {
    expect(
      profilingSessionsProblems(
        [
          session("2091-02-20", "09:00", "10:00", id(1)),
          session("2091-02-21", "09:00", "10:00", id(1)),
        ],
        today,
      ),
    ).toEqual([{ code: "duplicate_session", path: [1, "id"] }]);
  });

  it("takes times as hh:mm only, and at most 50 sessions", () => {
    const parse = (sessions: unknown[]) =>
      ProfilingSessionsInput.safeParse({ revision: 0, sessions }).success;
    expect(parse([session("2091-02-20", "09:00", "10:00")])).toBe(true);
    for (const time of ["9:00", "24:00", "09:60", "09:00:00"]) {
      expect(parse([session("2091-02-20", time, "23:00")])).toBe(false);
    }
    expect(parse(Array.from({ length: 51 }, () => session("2091-02-20", "09:00", "10:00")))).toBe(
      false,
    );
  });
});

describe("the pending declarations (ba-forms.md, declarations; Q193)", () => {
  it("takes a Jobbörse choice and the BA contact declaration, each undecided as null", () => {
    expect(
      ProfilingDeclarationsInput.safeParse({
        revision: 2,
        jobboerseChoice: "anonymous_callme",
        baContactConsent: false,
      }).success,
    ).toBe(true);
    expect(
      ProfilingDeclarationsInput.safeParse({
        revision: 2,
        jobboerseChoice: null,
        baContactConsent: null,
      }).success,
    ).toBe(true);
    expect(
      ProfilingDeclarationsInput.safeParse({
        revision: 2,
        jobboerseChoice: "public",
        baContactConsent: null,
      }).success,
    ).toBe(false);
  });
});

describe("section C and p. 7 (Q192)", () => {
  it("starts empty, the health line with a rating only", () => {
    const empty = emptyAssessment();
    expect(ProfilingAssessment.parse(empty)).toEqual(empty);
    expect(empty.health).toEqual({ rating: null });
    expect(empty.otherQualification).toEqual({ rating: null, text: null, label: null });
    expect(empty.schoolQualification).toEqual({ rating: null, text: null });
  });

  it("takes ratings, texts up to 300, labels up to 100 and p. 7 up to 2,000 characters", () => {
    const values = {
      ...emptyAssessment(),
      schoolQualification: { rating: "placement_relevant", text: "x".repeat(300) },
      otherMotivation: { rating: "no_need", text: null, label: "y".repeat(100) },
      health: { rating: "placement_relevant" },
      overallAssessment: "z".repeat(2000),
    };
    expect(parseProfilingAssessment(values)).toEqual({ ok: true, value: values });
  });

  it("refuses a text on the health line, an unknown key and an overlong text by code", () => {
    const result = parseProfilingAssessment({
      ...emptyAssessment(),
      schoolQualification: { rating: "kein", text: "x".repeat(301) },
      health: { rating: "no_need", text: "Rückenleiden" },
      otherConditions: { rating: null, text: null, label: "y".repeat(101) },
      nextSteps: "z".repeat(2001),
      notes: "frei",
    });
    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        { code: "value_not_allowed", path: ["schoolQualification", "rating"] },
        { code: "too_long", path: ["schoolQualification", "text"] },
        { code: "health_detail_not_recorded", path: ["health", "text"] },
        { code: "too_long", path: ["otherConditions", "label"] },
        { code: "too_long", path: ["nextSteps"] },
        { code: "unknown_field", path: ["notes"] },
      ]),
    });
    // A value from the issues is never echoed.
    expect(JSON.stringify(result)).not.toContain("Rückenleiden");
  });

  it("refuses an unknown key on a line as unknown, not as health detail", () => {
    expect(
      parseProfilingAssessment({
        ...emptyAssessment(),
        initiative: { rating: null, text: null, label: "a" },
      }),
    ).toEqual({ ok: false, issues: [{ code: "unknown_field", path: ["initiative", "label"] }] });
  });

  it("audits each field on its own: thirteen lines, p. 7's two texts and the health rating", () => {
    expect(assessmentFieldKeys).toHaveLength(16);
    expect(assessmentFieldKeys).toContain("profilingAssessment.otherConditions");
    expect(assessmentFieldKeys.at(-1)).toBe("profilingHealthAssessment");
  });
});

describe("the unemployment period (Q85)", () => {
  it("takes a start with an optional end, or null; a reversed range is no refusal", () => {
    const parse = (period: unknown) => UnemploymentPeriodInput.safeParse({ period }).success;
    expect(parse({ from: "2090-06-01", until: null })).toBe(true);
    expect(parse({ from: "2090-06-01", until: "2090-01-01" })).toBe(true);
    expect(parse(null)).toBe(true);
    expect(parse({ from: null, until: "2090-01-01" })).toBe(false);
    expect(parse({ from: "2090-02-30", until: null })).toBe(false);
  });
});
