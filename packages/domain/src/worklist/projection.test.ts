import { describe, expect, it } from "vitest";
import { wave } from "../lifecycle/testing/context";
import { snapshot, state } from "../lifecycle/testing/planner";
import {
  portalReach,
  reachableConsentVersion,
  worklistMaxRows,
  worklistProjection,
  type WorklistFacts,
  type WorklistViewer,
} from "./projection";

// Synthetic values only.
const facts = (overrides: Partial<WorklistFacts> = {}): WorklistFacts => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  entryWaveId: null,
  placementAgenturKey: null,
  person: { personnelNumber: "P-0001", lastName: "Muster", firstName: null },
  consultants: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "due", dueOn: "2027-03-20", providedAt: null },
  completeness: {
    projectType: "ta_tg",
    rules: { data_collection: [{ id: "r-mobile", kind: "required", field: "mobile" }] },
    fields: {},
    documents: {},
    customFieldKeys: [],
  },
  channels: [],
  ...overrides,
});
const viewer = (overrides: Partial<WorklistViewer> = {}): WorklistViewer => ({
  staffUserId: "00000000-0000-4000-8000-000000000003",
  lists: () => true,
  knows: () => true,
  may: () => true,
  ...overrides,
});
const project = {
  id: "project-1",
  type: "ta_tg" as const,
  waves: [wave, { ...wave, id: "wave-2" }],
};
const now = new Date("2027-03-10T09:00:00Z");

const at = (v: WorklistViewer, s = snapshot()) =>
  worklistProjection(facts(), s, project, "2027-03-10", now, v).capabilities.assignEntryWave;

describe("worklistProjection", () => {
  it("projects statuses, listable person fields, actions, deadlines, flags, portal and capabilities", () => {
    const s = snapshot({ wave: null });
    expect(worklistProjection(facts(), s, project, "2027-03-10", now, viewer())).toEqual({
      id: "00000000-0000-4000-8000-0000000000a1",
      status: "informed",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
      entryWaveId: null,
      placementAgenturKey: null,
      personnelNumber: "P-0001",
      lastName: "Muster",
      consultants: [],
      activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
      privacyNoticeState: { state: "due", dueOn: "2027-03-20", providedAt: null },
      actions: [{ kind: "field", key: "mobile", state: "missing" }],
      deadlines: [{ kind: "privacy_notice", date: "2027-03-20", state: "upcoming" }],
      flags: [],
      portal: "not_reachable",
      capabilities: {
        assignEntryWave: true,
        issueActivationCode: true,
        recordHandover: true,
        revokeActivationCode: true,
        providePrivacyNotice: true,
      },
    });
  });

  it("leaves out person fields the viewer may not list and fields they may not know about", () => {
    const item = worklistProjection(
      facts(),
      snapshot(),
      project,
      "2027-03-10",
      now,
      viewer({ lists: (field) => field !== "lastName", knows: (key) => key !== "mobile" }),
    );
    expect(item).toMatchObject({ personnelNumber: "P-0001", actions: [] });
    expect(item).not.toHaveProperty("lastName");
  });

  it("gives a terminal participation no actions", () => {
    const s = snapshot({ current: state("withdrawn") });
    expect(worklistProjection(facts(), s, project, "2027-03-10", now, viewer()).actions).toEqual(
      [],
    );
  });

  it("keeps only the flags no deadline represents", () => {
    // Signed DSV with a refused profiling: a conflict at the cutoff, plus a missed TG start.
    const s = snapshot({ current: state("informed", "profiling_declined", "dsv_signed") });
    const item = worklistProjection(facts(), s, project, "2027-05-02", now, viewer());
    expect(item.flags).toEqual(["conflict_dsv_signed_profiling_declined"]);
    expect(item.deadlines.map((d) => [d.kind, d.state])).toEqual([
      ["tg_start", "overdue"],
      ["latest_entry_cutoff", "overdue"],
      ["privacy_notice", "overdue"],
    ]);
  });

  it("assigns a wave by the permission, then the detail's rules", () => {
    expect(at(viewer())).toBe(true);
    expect(at(viewer({ may: (op) => op !== "assignEntryWave" }))).toBe(false);
    expect(
      at(viewer(), snapshot({ current: state("informed", "not_started", "dsv_offered") })),
    ).toBe(false);
  });
});

const channel = (overrides = {}) => ({
  live: true,
  consentVersion: reachableConsentVersion,
  consentEnded: false,
  ...overrides,
});

describe("portalReach", () => {
  it("is reachable through a live channel with a live consent of the reminders' version", () => {
    expect(reachableConsentVersion).toBe("portal-contact-consent:v2");
    expect(portalReach([channel({ live: false }), channel()])).toBe("reachable");
  });

  it("needs a consent with a live channel of an older version or an ended consent", () => {
    expect(portalReach([channel({ consentVersion: "portal-contact-consent:v1" })])).toBe(
      "consent_required",
    );
    expect(portalReach([channel({ consentEnded: true })])).toBe("consent_required");
  });

  it("isn't reachable without a live channel", () => {
    expect(portalReach([])).toBe("not_reachable");
    expect(portalReach([channel({ live: false })])).toBe("not_reachable");
  });

  it("bounds the snapshot", () => {
    expect(worklistMaxRows).toBe(5000);
  });
});
