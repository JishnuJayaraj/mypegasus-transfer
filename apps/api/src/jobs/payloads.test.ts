import { describe, expect, it } from "vitest";
import { EvaluateProjectPayload, SweepPayload } from "./payloads";

// AC-40 (plan 5.9): job payloads carry IDs and dates only, one strict schema per job.
const projectId = "00000000-0000-4000-9000-000000000002";
const valid = {
  projectId,
  runDate: "2025-03-05",
  days: [
    { day: "2025-03-04", scheduledAt: "2025-03-04T03:15:00.000Z" },
    { day: "2025-03-05", scheduledAt: "2025-03-05T03:15:00.000Z" },
  ],
};

describe("EvaluateProjectPayload", () => {
  it("parses ids and dates; the scheduled times become instants", () => {
    const parsed = EvaluateProjectPayload.parse(valid);
    expect(parsed.days.map((d) => d.scheduledAt.toISOString())).toEqual([
      "2025-03-04T03:15:00.000Z",
      "2025-03-05T03:15:00.000Z",
    ]);
  });

  it.each([
    ["an extra key (free text)", { ...valid, note: "call back" }],
    ["an extra key on a day", { ...valid, days: [{ ...valid.days[1], reason: "x" }] }],
    ["a project id that isn't a uuid", { ...valid, projectId: "Werk Nord" }],
    ["an impossible run date", { ...valid, runDate: "2025-02-30" }],
    ["no days", { ...valid, days: [] }],
    [
      "a scheduled time that isn't an ISO instant",
      { ...valid, days: [{ day: "2025-03-05", scheduledAt: "04:15" }] },
    ],
    ["a window that doesn't end on the run date", { ...valid, runDate: "2025-03-06" }],
    ["days out of order", { ...valid, days: valid.days.toReversed() }],
  ])("refuses %s", (_label, payload) => {
    expect(EvaluateProjectPayload.safeParse(payload).success).toBe(false);
  });
});

describe("SweepPayload", () => {
  it("is empty (the cron sends nothing)", () => {
    expect(SweepPayload.parse({})).toEqual({});
    expect(SweepPayload.parse(null)).toBeNull();
    expect(SweepPayload.safeParse({ today: "2025-03-05" }).success).toBe(false);
  });
});
