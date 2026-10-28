import { describe, expect, it } from "vitest";
import { activationOf, matchesWorklistFilter, WorklistFilter } from "./filter";
import { DashboardGroup, funnelFilters, ProjectDashboard, projectFunnel } from "./funnel";
import { item } from "./testing/item";
import type { AppointmentItemKind } from "./appointments";
import type { WorklistItem } from "./projection";

// Synthetic rows.
const waveId = "00000000-0000-4000-8000-0000000000f1";
const consultantId = "00000000-0000-4000-8000-000000000004";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const consultant = {
  staffUserId: consultantId,
  displayName: "Bernd Beratung",
  assignedAt: "2027-03-01T09:00:00.000Z",
};

const appointmentItem = (kind: AppointmentItemKind, n: number) => ({
  kind,
  appointmentId: id(100 + n),
  appointmentKind: "info_event" as const,
  startsAt: "2027-03-01T09:00:00.000Z",
});

const items: WorklistItem[] = [
  item({ id: id(1) }),
  item({
    id: id(2),
    entryWaveId: waveId,
    consultants: [consultant],
    actions: [
      { kind: "field", key: "mobile", state: "missing" },
      { kind: "document", key: "cv", state: "rejected" },
    ],
    deadlines: [
      { kind: "tg_start", date: "2027-04-01", state: "upcoming" },
      { kind: "privacy_notice", date: "2027-03-01", state: "overdue" },
    ],
    flags: ["dsv_never_offered", "informed_without_wave_at_cutoff"],
    portal: "consent_required",
    // Two items of one kind and a next booking: one participation each time.
    appointments: {
      next: { kind: "consultation", startsAt: "2027-03-20T09:00:00.000Z" },
      items: [
        appointmentItem("missed", 1),
        appointmentItem("missed", 2),
        appointmentItem("attendance_conflict", 3),
      ],
    },
  }),
  item({
    id: id(3),
    status: "imported",
    actions: [{ kind: "document", key: "cv", state: "missing" }],
    deadlines: [
      { kind: "latest_entry_cutoff", date: "2027-04-30", state: "upcoming", final: false },
      { kind: "privacy_notice", date: "2027-04-02", state: "upcoming" },
    ],
    activationStatus: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
    privacyNoticeState: { state: "due", dueOn: "2027-04-02", providedAt: null },
    portal: "reachable",
    appointments: { next: null, items: [appointmentItem("notice_undelivered", 4)] },
  }),
  item({
    id: id(4),
    status: "withdrawn",
    activationStatus: {
      account: "not_activated",
      code: "printed",
      issuedAt: "2027-03-01T09:00:00.000Z",
      expiresAt: "2027-04-01T09:00:00.000Z",
    },
    appointments: { next: null, items: [appointmentItem("attendance_missing", 5)] },
  }),
];

const ids = (filter: WorklistFilter) =>
  items.filter((row) => matchesWorklistFilter(row, filter)).map((row) => row.id);

describe("matchesWorklistFilter", () => {
  it("an empty filter matches every row; every set condition must hold", () => {
    expect(ids({})).toEqual([id(1), id(2), id(3), id(4)]);
    expect(ids({ status: "informed", actions: "any" })).toEqual([id(2)]);
    expect(
      ids({ profilingStatus: "not_started", dsvStatus: "not_offered", status: "imported" }),
    ).toEqual([id(3)]);
  });

  it("wave and consultant by id or none", () => {
    expect(ids({ wave: waveId })).toEqual([id(2)]);
    expect(ids({ wave: "none" })).toEqual([id(1), id(3), id(4)]);
    expect(ids({ consultant: consultantId })).toEqual([id(2)]);
    expect(ids({ consultant: "none" })).toEqual([id(1), id(3), id(4)]);
  });

  it("activation (an activated account, else the code) and the notice", () => {
    expect(activationOf(items[2]!)).toBe("activated");
    expect(ids({ activation: "activated" })).toEqual([id(3)]);
    expect(ids({ activation: "printed" })).toEqual([id(4)]);
    expect(ids({ activation: "none" })).toEqual([id(1), id(2)]);
    expect(ids({ notice: "due" })).toEqual([id(3)]);
  });

  it("actions: any, fields, documents, rejected documents, none", () => {
    expect(ids({ actions: "any" })).toEqual([id(2), id(3)]);
    expect(ids({ actions: "fields" })).toEqual([id(2)]);
    expect(ids({ actions: "documents" })).toEqual([id(2), id(3)]);
    expect(ids({ actions: "rejected_documents" })).toEqual([id(2)]);
    expect(ids({ actions: "none" })).toEqual([id(1), id(4)]);
  });

  it("a deadline kind and state match one deadline with both", () => {
    expect(ids({ deadlineState: "upcoming" })).toEqual([id(2), id(3)]);
    expect(ids({ deadlineKind: "privacy_notice" })).toEqual([id(2), id(3)]);
    expect(ids({ deadlineKind: "privacy_notice", deadlineState: "overdue" })).toEqual([id(2)]);
    expect(ids({ deadlineKind: "tg_start", deadlineState: "overdue" })).toEqual([]);
  });

  it("a flag or any flag, and the portal", () => {
    expect(ids({ flag: "dsv_never_offered" })).toEqual([id(2)]);
    expect(ids({ flag: "any" })).toEqual([id(2)]);
    expect(ids({ portal: "reachable" })).toEqual([id(3)]);
  });

  it("the appointments: upcoming, overdue, to resolve, each kind", () => {
    expect(ids({ appointment: "upcoming" })).toEqual([id(2)]);
    expect(ids({ appointment: "overdue" })).toEqual([id(2), id(4)]);
    expect(ids({ appointment: "to_resolve" })).toEqual([id(2), id(3)]);
    expect(ids({ appointment: "missed" })).toEqual([id(2)]);
    expect(ids({ appointment: "needs_resolution" })).toEqual([]);
    expect(ids({ appointment: "overdue", status: "withdrawn" })).toEqual([id(4)]);
  });

  it("is strict and takes codes and ids only", () => {
    expect(WorklistFilter.safeParse({ name: "Muster" }).success).toBe(false);
    expect(WorklistFilter.safeParse({ wave: "W1" }).success).toBe(false);
  });
});

describe("projectFunnel", () => {
  const project = { type: "ta_tg" as const, waves: [{ id: waveId }] };

  it("every count equals its filter's result in the same items", () => {
    const counts = projectFunnel(items, project);
    expect(
      ProjectDashboard.parse({ scope: "project", generatedAt: "2027-03-10T09:00:00.000Z", counts }),
    ).toBeTruthy();
    for (const group of DashboardGroup.options) {
      for (const { count, filter } of counts[group]) {
        expect(count).toBe(ids(filter).length);
      }
    }
  });

  it("tiles count distinct participations, never items", () => {
    const tiles = Object.fromEntries(
      projectFunnel(items, project).tiles.map((t) => [t.key, t.count]),
    );
    // Row 2 has two actions, two deadlines and two flags: one participation each time.
    expect(tiles).toEqual({
      participations: 4,
      open_actions: 2,
      deadline_upcoming: 2,
      deadline_overdue: 1,
      flags: 1,
      not_reachable: 2,
      appointments_overdue: 2,
      appointments_to_resolve: 2,
    });
  });

  it("has the waves and ohne Welle, the DSV track and every deadline kind × state in ta_tg", () => {
    const filters = funnelFilters(project);
    expect(filters.waves.map((w) => w.key)).toEqual([waveId, "none"]);
    expect(filters.dsvStatuses).toHaveLength(5);
    expect(filters.deadlines).toHaveLength(12);
    expect(filters.flags.map((f) => f.key)).toEqual([
      "conflict_dsv_signed_profiling_declined",
      "dsv_never_offered",
      "informed_without_wave_at_cutoff",
      "profiling_declined_after_entry",
    ]);
  });

  it("has the group Termine: one count per appointment filter", () => {
    const appointments = projectFunnel(items, project).appointments;
    expect(appointments.map((a) => [a.key, a.count])).toEqual([
      ["upcoming", 1],
      ["overdue", 2],
      ["to_resolve", 2],
      ["attendance_missing", 1],
      ["missed", 1],
      ["notice_undelivered", 1],
      ["needs_resolution", 0],
      ["attendance_conflict", 1],
    ]);
  });

  it("has no waves and no DSV track in ta_only", () => {
    const filters = funnelFilters({ type: "ta_only", waves: [] });
    expect([filters.waves, filters.dsvStatuses]).toEqual([[], []]);
  });

  it("counts nothing in an empty scope", () => {
    const counts = projectFunnel([], project);
    expect(counts.tiles.every((t) => t.count === 0)).toBe(true);
  });
});
