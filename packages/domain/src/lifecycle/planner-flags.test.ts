import { describe, expect, it } from "vitest";
import type { DatedFact } from "./guards";
import { lifecycleFlags } from "./planner";
import { project, snapshot, state } from "./testing/planner";

// Entered on 2027-04-01 under an approved exception: profiling is due by 2027-05-01 (Q74).
const approved: DatedFact = { validOn: "2027-03-01", recordedAt: new Date("2027-03-01T09:00:00Z") };
const entered = { tgStart: null, offerDeadline: null, tgEntryDate: "2027-04-01" };

function inTg(
  profiling: Parameters<typeof state>[1],
  extra: Partial<Parameters<typeof snapshot>[0]> = {},
) {
  return snapshot({
    current: state("active_in_tg", profiling, "dsv_signed"),
    participation: entered,
    facts: { profilingExceptionApproved: approved },
    ...extra,
  });
}

describe("compliance flags after entry (Q74, Q82)", () => {
  it("the one-month deadline is missed from the day after it", () => {
    expect(lifecycleFlags(inTg("profiling_in_progress"), project, "2027-05-01")).toEqual([]);
    expect(lifecycleFlags(inTg("profiling_in_progress"), project, "2027-05-02")).toEqual([
      "profiling_exception_deadline_missed",
    ]);
    expect(lifecycleFlags(inTg("not_started"), project, "2027-05-02")).toEqual([
      "profiling_exception_deadline_missed",
    ]);
  });

  it("isn't missed once profiling is done, nor without an approved exception or entry date", () => {
    expect(lifecycleFlags(inTg("profiling_done"), project, "2027-06-01")).toEqual([]);
    expect(
      lifecycleFlags(inTg("profiling_in_progress", { facts: {} }), project, "2027-06-01"),
    ).toEqual([]);
    const noEntry = { ...entered, tgEntryDate: null };
    expect(
      lifecycleFlags(
        inTg("profiling_in_progress", { participation: noEntry }),
        project,
        "2027-06-01",
      ),
    ).toEqual([]);
  });

  it("a refusal after entry is escalated at once", () => {
    expect(lifecycleFlags(inTg("profiling_declined"), project, "2027-04-02")).toEqual([
      "profiling_declined_after_entry",
    ]);
  });

  it("an exited participation raises none", () => {
    const exited = inTg("profiling_declined", {
      current: state("exited", "profiling_declined", "dsv_signed"),
    });
    expect(lifecycleFlags(exited, project, "2027-06-01")).toEqual([]);
  });
});

const informed = (tgStart: string) =>
  snapshot({
    current: state("informed", "profiling_done", "dsv_signed"),
    participation: { tgStart, offerDeadline: null, tgEntryDate: null },
  });

describe("tg_start_missed (round 9)", () => {
  it("from the day after a start that passed without entry", () => {
    expect(lifecycleFlags(informed("2027-04-01"), project, "2027-04-01")).toEqual([]);
    expect(lifecycleFlags(informed("2027-04-01"), project, "2027-04-02")).toEqual([
      "tg_start_missed",
    ]);
  });
});
