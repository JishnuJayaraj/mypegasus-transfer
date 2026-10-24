import { describe, expect, it } from "vitest";
import { wave } from "../lifecycle/testing/context";
import { snapshot, state } from "../lifecycle/testing/planner";
import {
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
  lastReminder: null,
  appointments: { bookings: [], notices: [], closedAt: null },
  ...overrides,
});
const viewer = (overrides: Partial<WorklistViewer> = {}): WorklistViewer => ({
  staffUserId: "00000000-0000-4000-8000-000000000003",
  lists: () => true,
  knows: () => true,
  may: () => true,
  remind: true,
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
      reminder: null,
      appointments: { next: null, items: [] },
      capabilities: {
        assignEntryWave: true,
        issueActivationCode: true,
        recordHandover: true,
        revokeActivationCode: true,
        providePrivacyNotice: true,
        remind: { allowed: false, code: "no_channel", channel: null },
        invite: { allowed: true, channel: null },
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

const channel = {
  id: "00000000-0000-4000-8000-0000000000c1",
  kind: "sms" as const,
  verifiedAt: "2027-03-01T09:00:00.000Z",
  live: true,
  consentVersion: "portal-contact-consent:v2",
  consentEnded: false,
};

const remind = (overrides: Partial<WorklistFacts>, v = viewer()) =>
  worklistProjection(facts(overrides), snapshot(), project, "2027-03-10", now, v);

describe("the reminder of a row", () => {
  it("names the channel kind a permitted reminder would go to", () => {
    const item = remind({ channels: [channel] });
    expect(item.portal).toBe("reachable");
    expect(item.capabilities.remind).toEqual({ allowed: true, code: null, channel: "sms" });
  });

  it("gives the skip code, and nothing to a viewer who may not remind", () => {
    const lastReminder = { requestedOn: "2027-03-08", status: "sent" } as const;
    const item = remind({ channels: [channel], lastReminder });
    expect(item.reminder).toEqual({ lastRequestedOn: "2027-03-08", status: "sent" });
    expect(item.capabilities.remind).toEqual({
      allowed: false,
      code: "reminded_recently",
      channel: null,
    });
    expect(remind({ channels: [channel] }, viewer({ remind: false })).capabilities.remind).toEqual({
      allowed: false,
      code: null,
      channel: null,
    });
  });
});

describe("the invitation of a row (data-protection.md, invitations)", () => {
  it("names the channel an invitation would go to, also inside the reminder window", () => {
    const lastReminder = { requestedOn: "2027-03-09", status: "sent" } as const;
    expect(remind({ channels: [channel], lastReminder }).capabilities.invite).toEqual({
      allowed: true,
      channel: "sms",
    });
    expect(remind({ channels: [] }).capabilities.invite).toEqual({ allowed: true, channel: null });
    expect(remind({ channels: [channel] }, viewer({ remind: false })).capabilities.invite).toEqual({
      allowed: false,
      channel: null,
    });
  });
});

describe("the appointments of a row (process-and-lifecycle.md, appointment items)", () => {
  it("projects the next booking and the items at the snapshot's time", () => {
    const booking = {
      id: "00000000-0000-4000-8000-0000000000b1",
      appointmentId: "00000000-0000-4000-8000-0000000000b2",
      appointmentKind: "info_event" as const,
      appointmentStatus: "scheduled" as const,
      startsAt: "2027-03-08T09:00:00.000Z",
      endsAt: "2027-03-08T10:00:00.000Z",
      status: "booked" as const,
      attendance: null,
      followUpOf: null,
      missedResolution: null,
      conflict: null,
      hostMayList: null,
    };
    const next = {
      ...booking,
      id: "00000000-0000-4000-8000-0000000000b3",
      startsAt: "2027-03-12T09:00:00.000Z",
      endsAt: "2027-03-12T10:00:00.000Z",
    };
    const item = remind({
      appointments: { bookings: [booking, next], notices: [], closedAt: null },
    });
    expect(item.appointments).toEqual({
      next: { kind: "info_event", startsAt: "2027-03-12T09:00:00.000Z" },
      items: [
        {
          kind: "attendance_missing",
          appointmentId: booking.appointmentId,
          appointmentKind: "info_event",
          startsAt: booking.startsAt,
        },
      ],
    });
  });
});

describe("the snapshot", () => {
  it("is bounded", () => {
    expect(worklistMaxRows).toBe(5000);
  });
});
