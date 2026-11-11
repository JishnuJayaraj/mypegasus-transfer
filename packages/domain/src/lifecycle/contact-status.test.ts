import { describe, expect, it } from "vitest";
import type { Edge } from "./edges";
import type { MainStatus } from "./enums";
import {
  contactEdges,
  ContactStatusRequest,
  contactTransitions,
  mayTakeSomeContactStep,
} from "./contact-status";
import { context } from "./testing/context";

const all = () => true;
const none = () => false;
const at = (status: MainStatus, today = "2027-03-01") =>
  context({ current: { status, profilingStatus: "not_started", dsvStatus: "not_offered" }, today });

describe("the manual contact statuses (process-and-lifecycle.md, Q215)", () => {
  it("has exactly the three manual contact edges", () => {
    expect(contactEdges.map((e) => `${e.from}→${e.to}`)).toEqual([
      "imported→contacted",
      "contacted→unreachable",
      "unreachable→contacted",
    ]);
  });

  it("offers imported → contacted", () => {
    expect(contactTransitions(at("imported"), all, true)).toEqual([
      { to: "contacted", allowed: true, refusal: null },
    ]);
  });

  it("offers contacted → unreachable (contacted → informed is the attendance's)", () => {
    expect(contactTransitions(at("contacted"), all, true)).toEqual([
      { to: "unreachable", allowed: true, refusal: null },
    ]);
  });

  it("offers unreachable → contacted on the cutoff day, refuses it the day after", () => {
    // The wave's latestEntryDate is 2027-04-30 (before_cutoff: today ≤ latestEntryDate).
    expect(contactTransitions(at("unreachable", "2027-04-30"), all, true)).toEqual([
      { to: "contacted", allowed: true, refusal: null },
    ]);
    expect(contactTransitions(at("unreachable", "2027-05-01"), all, true)).toEqual([
      { to: "contacted", allowed: false, refusal: "before_cutoff" },
    ]);
  });

  it("imported → contacted has no cutoff guard", () => {
    expect(contactTransitions(at("imported", "2027-05-01"), all, true)[0]!.allowed).toBe(true);
  });

  it.each<MainStatus>(["informed", "active_in_tg", "withdrawn", "ta_completed", "exited"])(
    "offers nothing from %s",
    (status) => {
      expect(contactTransitions(at(status), all, true)).toEqual([]);
    },
  );

  it("closes by permission first, then the project", () => {
    expect(contactTransitions(at("imported"), none, false)).toEqual([
      { to: "contacted", allowed: false, refusal: "forbidden" },
    ]);
    expect(contactTransitions(at("imported"), all, false)).toEqual([
      { to: "contacted", allowed: false, refusal: "project_not_active" },
    ]);
  });

  it("knows whether the viewer may take any contact step", () => {
    expect(mayTakeSomeContactStep(all)).toBe(true);
    expect(mayTakeSomeContactStep(none)).toBe(false);
    expect(mayTakeSomeContactStep((e: Edge) => e.to === "unreachable")).toBe(true);
  });

  it("takes only a contact target and the status version", () => {
    expect(ContactStatusRequest.safeParse({ to: "contacted", statusVersion: 2 }).success).toBe(
      true,
    );
    expect(ContactStatusRequest.safeParse({ to: "informed", statusVersion: 2 }).success).toBe(
      false,
    );
    expect(ContactStatusRequest.safeParse({ to: "contacted" }).success).toBe(false);
  });
});
