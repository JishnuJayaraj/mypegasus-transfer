import { describe, expect, it } from "vitest";
import { EvaluateProjectPayload, SweepPayload } from "./payloads";

// AC-40 (plan 5.9, round 21): job payloads carry IDs and dates only, one strict schema per job;
// the project job gets the window's bounds, never its days or instants.
const projectId = "00000000-0000-4000-9000-000000000002";
const valid = { projectId, firstDay: "2025-03-04", runDate: "2025-03-05" };

describe("EvaluateProjectPayload", () => {
  it("parses a project id and the window's bounds", () => {
    expect(EvaluateProjectPayload.parse(valid)).toEqual(valid);
    expect(EvaluateProjectPayload.parse({ ...valid, firstDay: "2025-03-05" }).firstDay).toBe(
      "2025-03-05",
    );
  });

  it.each([
    ["an extra key (free text)", { ...valid, note: "call back" }],
    ["caller-supplied days", { ...valid, days: [{ day: "2025-03-05", scheduledAt: "x" }] }],
    ["a project id that isn't a uuid", { ...valid, projectId: "Werk Nord" }],
    ["an impossible run date", { ...valid, runDate: "2025-02-30" }],
    ["a missing first day", { projectId, runDate: "2025-03-05" }],
    ["a first day after the run date", { ...valid, firstDay: "2025-03-06" }],
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
