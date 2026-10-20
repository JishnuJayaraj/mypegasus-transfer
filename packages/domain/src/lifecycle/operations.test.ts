import { describe, expect, it } from "vitest";
import type { MainStatus } from "./enums";
import {
  assignEntryWave,
  correctEndReason,
  operationFailures,
  type EndReasonRecord,
  type OperationContext,
} from "./operations";
import { context } from "./testing/context";

const now = new Date("2027-03-01T09:00:00Z");
const fail = (code: string) => ({ ok: false, code });

function op(extra: Partial<OperationContext> = {}): OperationContext {
  return { ...context(), now, ...extra };
}
const withStatus = (status: MainStatus, extra: Partial<OperationContext["current"]> = {}) => ({
  current: { ...context().current, status, ...extra },
});

describe("assigning the entry wave (AC-7, Q79)", () => {
  const target = { projectId: "project-1", wave: { id: "wave-2", projectId: "project-1" } };

  it.each(["imported", "contacted", "unreachable", "informed"] as const)(
    "assigns a wave of the same project while %s and the DSV isn't offered",
    (status) => {
      expect(assignEntryWave(op(withStatus(status)), target)).toEqual({
        ok: true,
        next: { waveId: "wave-2" },
      });
    },
  );

  it.each(["dsv_offered", "dsv_signed", "dsv_declined", "dsv_expired"] as const)(
    "can't change the wave once the DSV is %s",
    (dsvStatus) => {
      expect(assignEntryWave(op(withStatus("informed", { dsvStatus })), target)).toEqual(
        fail("dsv_already_offered"),
      );
    },
  );

  it.each(["active_in_tg", "withdrawn", "exited"] as const)("is refused while %s", (status) => {
    expect(assignEntryWave(op(withStatus(status)), target)).toEqual(fail("status_not_open"));
  });

  it("refuses the current wave again as a no-op (round 16)", () => {
    const same = { ...target, wave: { id: "wave-1", projectId: "project-1" } };
    expect(assignEntryWave(op(), same)).toEqual(fail("wave_unchanged"));
    expect(assignEntryWave(op({ wave: null }), same)).toEqual({
      ok: true,
      next: { waveId: "wave-1" },
    });
  });

  it("keeps the wave of a participation with individual dates (R33)", () => {
    for (const participation of [
      { tgStart: "2027-04-15", offerDeadline: null },
      { tgStart: null, tgEnd: "2028-02-29", offerDeadline: null },
    ]) {
      expect(assignEntryWave(op({ participation }), target)).toEqual(fail("individual_dates_set"));
    }
    const unset = { tgStart: null, tgEnd: null, offerDeadline: null };
    expect(assignEntryWave(op({ participation: unset }), target)).toMatchObject({ ok: true });
  });

  it("is refused for another project's wave, in ta_only and for the system", () => {
    const other = { ...target, wave: { id: "wave-9", projectId: "project-2" } };
    expect(assignEntryWave(op(), other)).toEqual(fail("wave_of_other_project"));
    expect(assignEntryWave(op({ projectType: "ta_only" }), target)).toEqual(fail("not_ta_tg"));
    expect(assignEntryWave(op({ actor: { type: "system" } }), target)).toEqual(
      fail("actor_not_allowed"),
    );
  });
});

describe("correcting the end reason (AC-11, Q72)", () => {
  const derived: EndReasonRecord = {
    endReason: "no_response",
    source: "system",
    secondaryReasons: ["declined_profiling"],
  };
  const withdrawn = op(withStatus("withdrawn"));

  it("replaces the primary reason; a system-derived one moves to the secondary list", () => {
    expect(correctEndReason(withdrawn, derived, "placed_direct")).toEqual({
      ok: true,
      next: {
        endReason: "placed_direct",
        source: "user",
        secondaryReasons: ["no_response", "declined_profiling"],
      },
    });
    expect(correctEndReason(withdrawn, derived, "declined_profiling")).toEqual({
      ok: true,
      next: { endReason: "declined_profiling", source: "user", secondaryReasons: ["no_response"] },
    });
  });

  it("a previous staff reason stays in the audit history only, unless the PL confirms it", () => {
    const chosen: EndReasonRecord = { ...derived, endReason: "placed_direct", source: "user" };
    expect(correctEndReason(withdrawn, chosen, "retirement")).toEqual({
      ok: true,
      next: { endReason: "retirement", source: "user", secondaryReasons: ["declined_profiling"] },
    });
    expect(
      correctEndReason(withdrawn, chosen, "retirement", { previousStillApplies: true }),
    ).toEqual({
      ok: true,
      next: {
        endReason: "retirement",
        source: "user",
        secondaryReasons: ["placed_direct", "declined_profiling"],
      },
    });
  });

  it("enforces the phase of the terminal status and doesn't reopen it", () => {
    expect(correctEndReason(withdrawn, derived, "placed_permanent")).toEqual(
      fail("reason_wrong_phase"),
    );
    const exited = op(withStatus("exited"));
    const record: EndReasonRecord = { endReason: "other", source: "user", secondaryReasons: [] };
    expect(correctEndReason(exited, record, "placed_permanent").ok).toBe(true);
    expect(correctEndReason(exited, record, "long_term_illness_reduced_earning_capacity")).toEqual(
      fail("reason_not_storable"),
    );
  });

  it.each(["informed", "active_in_tg", "ta_completed"] as const)(
    "has no end reason to correct while %s",
    (status) => {
      expect(correctEndReason(op(withStatus(status)), derived, "placed_direct")).toEqual(
        fail("no_end_reason"),
      );
    },
  );

  it("is refused for the same reason and for the system", () => {
    expect(correctEndReason(withdrawn, derived, "no_response")).toEqual(fail("reason_unchanged"));
    const system = op({ ...withStatus("withdrawn"), actor: { type: "system" } });
    expect(correctEndReason(system, derived, "placed_direct")).toEqual(fail("actor_not_allowed"));
  });
});

it("every operation lists its failure codes in check order (for the generated table)", () => {
  expect(Object.keys(operationFailures)).toEqual([
    "assignEntryWave",
    "requestProfilingException",
    "decideProfilingException",
    "revokeProfilingException",
    "supersedeStaleException",
    "correctEndReason",
  ]);
});
