import { describe, expect, it } from "vitest";
import { errorForLog } from "./logger";

// CLAUDE.md rule 9, round 21: an error goes into a log as its name, code and stack frames only;
// a message, single- or multiline, never does.
describe("errorForLog", () => {
  it("keeps only stack frames, never a line of a multiline message", () => {
    const error = Object.assign(
      new Error("lookup failed\nparticipant 4711, born 01.02.1970\n  at their home address"),
      { code: "57P01" },
    );
    const logged = errorForLog(error);
    expect(logged).toMatchObject({ name: "Error", code: "57P01" });
    const lines = logged.stack!.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\s+at /);
    expect(JSON.stringify(logged)).not.toMatch(/4711|1970|lookup failed|home address/);
  });

  it("keeps the frames of a single-line message and handles non-errors", () => {
    const logged = errorForLog(new TypeError("participant 4711"));
    expect(logged.stack).toMatch(/^\s+at /);
    expect(JSON.stringify(logged)).not.toContain("4711");
    expect(errorForLog("participant 4711")).toEqual({ name: "string" });
    const stackless = Object.assign(new Error("x"), { stack: undefined });
    expect(errorForLog(stackless).stack).toBeUndefined();
  });
});
