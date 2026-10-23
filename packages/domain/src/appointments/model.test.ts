import { describe, expect, it } from "vitest";
import {
  AppointmentChangeInput,
  AppointmentInput,
  berlinDate,
  berlinInstant,
  berlinTime,
  bookingClosesAt,
  bookingCutoffDays,
} from "./model";

const base = {
  kind: "info_event",
  startsAt: "2091-02-10T09:00:00.000Z",
  endsAt: "2091-02-10T11:00:00.000Z",
  capacity: 40,
  venue: "Kantine Werk 2",
};
const codes = (input: unknown) => {
  const parsed = AppointmentInput.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => (issue as { params?: { code?: string } }).params?.code ?? issue.code,
      );
};

describe("AppointmentInput", () => {
  it("takes the defaults: a one-day cutoff, no title, host or wave", () => {
    expect(AppointmentInput.parse(base)).toEqual({
      ...base,
      bookingCutoffDays: 1,
      title: null,
      hostStaffUserId: null,
      audienceWaveId: null,
    });
  });

  it("trims the texts and refuses empty, long or control characters", () => {
    expect(AppointmentInput.parse({ ...base, venue: "  Raum 1 ", title: " Info " })).toMatchObject({
      venue: "Raum 1",
      title: "Info",
    });
    expect(codes({ ...base, venue: " " })).toEqual(["too_small"]);
    expect(codes({ ...base, venue: "x".repeat(201) })).toEqual(["too_big"]);
    expect(codes({ ...base, title: "x".repeat(101) })).toEqual(["too_big"]);
    expect(codes({ ...base, venue: "Raum\n1" })).toEqual(["control_character"]);
  });

  it("bounds capacity 1–500 and the cutoff 0–14 days", () => {
    expect(codes({ ...base, capacity: 0 })).toEqual(["too_small"]);
    expect(codes({ ...base, capacity: 501 })).toEqual(["too_big"]);
    expect(codes({ ...base, capacity: 500, bookingCutoffDays: 0 })).toEqual([]);
    expect(codes({ ...base, bookingCutoffDays: 14 })).toEqual([]);
    expect(codes({ ...base, bookingCutoffDays: 15 })).toEqual(["too_big"]);
  });

  it("needs the end after the start", () => {
    expect(codes({ ...base, endsAt: base.startsAt })).toEqual(["ends_before_start"]);
  });

  it("gives a consultation a host and no wave, an info event no host", () => {
    const host = "00000000-0000-4000-8000-000000000004";
    const wave = "00000000-0000-4000-b000-000000000001";
    expect(codes({ ...base, kind: "consultation", hostStaffUserId: host })).toEqual([]);
    expect(codes({ ...base, kind: "consultation" })).toEqual(["host_mismatch"]);
    expect(codes({ ...base, hostStaffUserId: host })).toEqual(["host_mismatch"]);
    expect(codes({ ...base, audienceWaveId: wave })).toEqual([]);
    expect(
      codes({ ...base, kind: "consultation", hostStaffUserId: host, audienceWaveId: wave }),
    ).toEqual(["audience_mismatch"]);
  });

  it("is strict", () => {
    expect(codes({ ...base, createdBy: "someone" })).toEqual(["unrecognized_keys"]);
  });
});

describe("AppointmentChangeInput", () => {
  it("needs something to change besides the version", () => {
    expect(AppointmentChangeInput.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(AppointmentChangeInput.parse({ expectedVersion: 1, title: null })).toEqual({
      expectedVersion: 1,
      title: null,
    });
  });
});

describe("the cutoff and Berlin times", () => {
  it("puts the cutoff whole days before the start", () => {
    expect(bookingClosesAt(base.startsAt, 1)).toBe("2091-02-09T09:00:00.000Z");
    expect(bookingCutoffDays(base.startsAt, "2091-02-09T09:00:00.000Z")).toBe(1);
    expect(bookingClosesAt(base.startsAt, 0)).toBe(base.startsAt);
  });

  it("reads the Berlin date and time of an instant, winter and summer", () => {
    expect(berlinDate("2091-02-09T23:30:00.000Z")).toBe("2091-02-10");
    expect(berlinTime("2091-02-09T23:30:00.000Z")).toBe("00:30");
    expect(berlinTime("2091-07-01T08:00:00.000Z")).toBe("10:00");
  });

  it("makes the instant of a Berlin date and time", () => {
    expect(berlinInstant("2091-02-10", "10:00")).toBe("2091-02-10T09:00:00.000Z");
    expect(berlinInstant("2091-07-01", "10:00")).toBe("2091-07-01T08:00:00.000Z");
  });

  it("refuses a malformed time and one the clock change skips; a repeated one is the earlier", () => {
    expect(berlinInstant("2091-02-10", "24:00")).toBeNull();
    expect(berlinInstant("2091-02-10", "9:00")).toBeNull();
    // 2026: summer time starts 29 March at 02:00 and ends 25 October at 03:00.
    expect(berlinInstant("2026-03-29", "02:30")).toBeNull();
    expect(berlinInstant("2026-10-25", "02:30")).toBe("2026-10-25T00:30:00.000Z");
  });
});
