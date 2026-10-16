import { describe, expect, it } from "vitest";
import {
  ManualClock,
  SystemClock,
  assertRunTime,
  berlinDate,
  createClock,
  scheduledAt,
} from "./clock";

const at = (iso: string) => new Date(iso);

// Last Sundays: 2026-10-25 (CEST → CET at 01:00 UTC), 2027-03-28 (CET → CEST at 01:00 UTC).
describe("berlinDate (AC-36)", () => {
  it.each([
    ["2027-01-15T22:59:59.999Z", "2027-01-15"],
    ["2027-01-15T23:00:00.000Z", "2027-01-16"],
    ["2027-07-15T21:59:59.999Z", "2027-07-15"],
    ["2027-07-15T22:00:00.000Z", "2027-07-16"],
    ["2026-10-24T21:59:59.999Z", "2026-10-24"],
    ["2026-10-24T22:00:00.000Z", "2026-10-25"],
    ["2026-10-25T22:59:59.999Z", "2026-10-25"],
    ["2026-10-25T23:00:00.000Z", "2026-10-26"],
    ["2027-03-27T22:59:59.999Z", "2027-03-27"],
    ["2027-03-27T23:00:00.000Z", "2027-03-28"],
    ["2027-03-28T21:59:59.999Z", "2027-03-28"],
    ["2027-03-28T22:00:00.000Z", "2027-03-29"],
    ["2027-12-31T23:00:00.000Z", "2028-01-01"],
  ])("%s is %s in Berlin", (instant, date) => {
    expect(berlinDate(at(instant))).toBe(date);
  });
});

describe("scheduledAt: a Berlin local run time as an instant (AC-36)", () => {
  it.each([
    ["2026-10-24", "04:15", "2026-10-24T02:15:00.000Z"],
    ["2026-10-25", "04:15", "2026-10-25T03:15:00.000Z"],
    ["2026-10-26", "04:15", "2026-10-26T03:15:00.000Z"],
    ["2027-03-27", "04:15", "2027-03-27T03:15:00.000Z"],
    ["2027-03-28", "04:15", "2027-03-28T02:15:00.000Z"],
    ["2027-03-29", "04:15", "2027-03-29T02:15:00.000Z"],
    ["2026-10-25", "01:59", "2026-10-24T23:59:00.000Z"],
    ["2026-10-25", "03:00", "2026-10-25T02:00:00.000Z"],
    ["2027-03-28", "01:59", "2027-03-28T00:59:00.000Z"],
    ["2027-03-28", "03:00", "2027-03-28T01:00:00.000Z"],
    ["2027-01-01", "00:00", "2026-12-31T23:00:00.000Z"],
    ["2027-07-01", "23:59", "2027-07-01T21:59:00.000Z"],
  ])("%s at %s Berlin = %s", (day, time, instant) => {
    expect(scheduledAt(day, time).toISOString()).toBe(instant);
    expect(berlinDate(scheduledAt(day, time))).toBe(day);
  });

  it.each(["02:00", "02:30", "02:59"])("rejects %s: missing or doubled on DST days", (time) => {
    expect(() => assertRunTime(time)).toThrow(/02:00/);
    expect(() => scheduledAt("2027-01-15", time)).toThrow(RangeError);
  });

  it.each(["4:15", "24:00", "04:60", "", "04:15:00", " 04:15"])("rejects malformed %j", (time) => {
    expect(() => assertRunTime(time)).toThrow(RangeError);
  });

  it("rejects an impossible day", () => {
    expect(() => scheduledAt("2027-02-29", "04:15")).toThrow(RangeError);
  });
});

describe("ManualClock", () => {
  it("returns the instant it was set to, as a copy", () => {
    const clock = new ManualClock(at("2027-03-28T02:15:00Z"));
    clock.now().setTime(0);
    expect(clock.now().toISOString()).toBe("2027-03-28T02:15:00.000Z");
    clock.set(at("2027-12-31T23:30:00Z"));
    expect(clock.today()).toBe("2028-01-01");
  });

  it("advances by Berlin calendar days, keeping the local time across DST", () => {
    const clock = new ManualClock(at("2026-10-24T02:15:00Z"));
    clock.advanceDays(1);
    expect(clock.now().toISOString()).toBe("2026-10-25T03:15:00.000Z");
    clock.advanceDays(154);
    expect(clock.now().toISOString()).toBe("2027-03-28T02:15:00.000Z");
    clock.advanceDays(-1);
    expect([clock.today(), clock.now().toISOString()]).toEqual([
      "2027-03-27",
      "2027-03-27T03:15:00.000Z",
    ]);
  });
});

describe("SystemClock", () => {
  it("reads the system time and the Berlin date", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - before).toBeLessThan(1000);
    expect(clock.today()).toBe(berlinDate(new Date(now)));
  });
});

describe("createClock", () => {
  it("defaults to the system clock", () => {
    expect(createClock({})).toBeInstanceOf(SystemClock);
    expect(createClock({ CLOCK: "system", NODE_ENV: "production" })).toBeInstanceOf(SystemClock);
  });

  it("fixes the time in dev and tests", () => {
    const clock = createClock({ CLOCK: "fixed:2027-03-28T02:15:00Z", NODE_ENV: "test" });
    expect(clock).toBeInstanceOf(ManualClock);
    expect(clock.now().toISOString()).toBe("2027-03-28T02:15:00.000Z");
  });

  it("refuses a fixed clock in production", () => {
    expect(() =>
      createClock({ CLOCK: "fixed:2027-03-28T02:15:00Z", NODE_ENV: "production" }),
    ).toThrow("CLOCK=fixed is not allowed with NODE_ENV=production");
  });

  it.each(["fixed:", "fixed:2027-03-28", "fixed:yesterday", "manual", "System"])(
    "rejects CLOCK=%s",
    (value) => {
      expect(() => createClock({ CLOCK: value })).toThrow(/^Invalid CLOCK/);
    },
  );
});
