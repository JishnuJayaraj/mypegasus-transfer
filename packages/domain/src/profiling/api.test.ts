import { describe, expect, it } from "vitest";
import { context } from "../lifecycle/testing/context";
import type { Edge } from "../lifecycle/edges";
import { profilingTransitions, ProfilingStatusInput } from "./api";

const all = () => true;
const declinedOnly = (edge: Edge) => edge.to === "profiling_declined";
const at = (profilingStatus: "not_started" | "profiling_accepted" | "profiling_in_progress") =>
  context({
    current: { status: "informed", profilingStatus, dsvStatus: "not_offered" },
  });

describe("the profiling track's steps (process-and-lifecycle.md, profiling track)", () => {
  it("lists the manual steps from the current status, allowed while informed", () => {
    expect(profilingTransitions(at("not_started"), all, true)).toEqual([
      { to: "profiling_accepted", allowed: true, refusal: null },
      { to: "profiling_declined", allowed: true, refusal: null },
    ]);
  });

  it("refuses profiling_done on its guard while no signed TL 407 is recorded", () => {
    expect(profilingTransitions(at("profiling_in_progress"), all, true)).toEqual([
      { to: "profiling_done", allowed: false, refusal: "tl407_signed" },
      { to: "profiling_declined", allowed: true, refusal: null },
    ]);
  });

  it("closes the steps by permission first, then the project, then the track", () => {
    expect(profilingTransitions(at("not_started"), declinedOnly, false)).toEqual([
      { to: "profiling_accepted", allowed: false, refusal: "forbidden" },
      { to: "profiling_declined", allowed: false, refusal: "project_not_active" },
    ]);
    const contacted = context({
      current: { status: "contacted", profilingStatus: "not_started", dsvStatus: "not_offered" },
    });
    expect(profilingTransitions(contacted, all, true)).toEqual([
      { to: "profiling_accepted", allowed: false, refusal: "track_inactive" },
      { to: "profiling_declined", allowed: false, refusal: "track_inactive" },
    ]);
  });

  it("refuses a renewed agreement after the cutoff (Q77)", () => {
    const declined = context({
      current: {
        status: "informed",
        profilingStatus: "profiling_declined",
        dsvStatus: "not_offered",
      },
      today: "2027-05-01",
    });
    expect(profilingTransitions(declined, all, true)).toEqual([
      { to: "profiling_accepted", allowed: false, refusal: "before_cutoff" },
    ]);
  });

  it("takes the step with the status version, a date only as given", () => {
    expect(
      ProfilingStatusInput.safeParse({ to: "profiling_accepted", statusVersion: 3 }).success,
    ).toBe(true);
    expect(
      ProfilingStatusInput.safeParse({
        to: "profiling_done",
        effectiveDate: "2091-03-01",
        statusVersion: 3,
      }).success,
    ).toBe(true);
    expect(ProfilingStatusInput.safeParse({ to: "profiling_accepted" }).success).toBe(false);
  });
});
