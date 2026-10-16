import { describe, expect, it } from "vitest";
import { projectActivationBlockers } from "./activation";
import type { EntryWave } from "./waves";

const wave = (latestEntryDate: string | null): EntryWave => ({
  id: `w-${latestEntryDate}`,
  code: "W1",
  signingDeadline: null,
  defaultTgStart: null,
  defaultTgEnd: null,
  latestEntryDate,
});
const resolved = { blockers: [] };
const noProjectAgenturTemplate = {
  blockers: [
    { code: "agentur_submission_blocked" },
    { code: "project_activation_blocked" },
    { code: "project_activation_blocked" },
  ],
};

describe("projectActivationBlockers (Q76, Q77)", () => {
  it("a ta_tg project needs an entry wave with a latestEntryDate", () => {
    const tg = { type: "ta_tg" } as const;
    expect(projectActivationBlockers(tg, [], resolved)).toEqual([
      "no_entry_wave_with_latest_entry_date",
    ]);
    expect(projectActivationBlockers(tg, [wave(null)], resolved)).toEqual([
      "no_entry_wave_with_latest_entry_date",
    ]);
    // one wave with a cutoff is enough; a draft wave next to it doesn't block
    expect(projectActivationBlockers(tg, [wave(null), wave("2027-03-31")], resolved)).toEqual([]);
  });

  it("a ta_only project has no waves (Q79)", () => {
    expect(projectActivationBlockers({ type: "ta_only" }, [], resolved)).toEqual([]);
  });

  it("passes on the configuration's blocker for every project type (Q90)", () => {
    expect(projectActivationBlockers({ type: "ta_only" }, [], noProjectAgenturTemplate)).toEqual([
      "project_activation_blocked",
    ]);
    expect(projectActivationBlockers({ type: "ta_tg" }, [], noProjectAgenturTemplate)).toEqual([
      "project_activation_blocked",
      "no_entry_wave_with_latest_entry_date",
    ]);
  });

  it("a missing submission setting doesn't block activation (Q76)", () => {
    const submissionOnly = { blockers: [{ code: "agentur_submission_blocked" }] };
    expect(projectActivationBlockers({ type: "ta_only" }, [], submissionOnly)).toEqual([]);
  });
});
