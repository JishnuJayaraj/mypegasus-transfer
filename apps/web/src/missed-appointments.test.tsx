import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi, project, renderApp, staffUsers, unpinnedConfig } from "./test-utils";

// A missed appointment on the participant tab "Termine" (process-and-lifecycle.md, appointments:
// the work list): "Folgetermin buchen" links a consultation as the follow-up, "Keine weitere
// Nachverfolgung" takes a closed reason; both by capability. Synthetic data only.
const projectPath = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const detailPath = `/api/v1/participations/${participationId}`;
const missedId = "00000000-0000-4000-a000-0000000000b1";
const slotId = "00000000-0000-4000-a000-0000000000a2";
const eventId = "00000000-0000-4000-a000-0000000000a3";

const detail = {
  id: participationId,
  projectId: project.id,
  status: "contacted",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  statusVersion: 1,
  entryWave: null,
  dates: {
    tgStart: null,
    tgEnd: null,
    effectiveTgStart: null,
    effectiveTgEnd: null,
    offerDeadline: null,
    tgEntryDate: null,
    exitDate: null,
    withdrawnOn: null,
    profilingDoneOn: null,
  },
  hints: [],
  placementAgenturKey: null,
  placementAgenturSetAt: null,
  submissionBlockers: [],
  placementAgenturChoices: [],
  person: { personnelNumber: "BSP-0001", lastName: "Beispiel", firstName: "Erika" },
  assignments: [],
  activationStatus: { account: "activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "provided", dueOn: "2026-11-15", providedAt: null },
  capabilities: {
    assignEntryWave: false,
    setParticipationDates: false,
    assignParticipations: false,
    issueActivationCode: false,
    recordHandover: false,
    revokeActivationCode: false,
    providePrivacyNotice: false,
    setPlacementAgentur: false,
    startAssistedMode: false,
    viewProfiling: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

const summary = (id: string, kind: string, startsAt: string, endsAt: string) => ({
  id,
  kind,
  startsAt,
  endsAt,
  title: null,
  venue: "Raum 1",
  status: "scheduled",
});

const missedBooking = (missed: { followUp: boolean; resolve: boolean } | null) => ({
  id: missedId,
  appointment: summary(
    "00000000-0000-4000-a000-0000000000a1",
    "consultation",
    "2026-10-20T08:00:00.000000Z",
    "2026-10-20T09:00:00.000000Z",
  ),
  status: "booked",
  origin: "staff",
  bookedAt: "2026-10-15T08:00:00.000000Z",
  cancelReason: null,
  cancelledAt: null,
  attendance: "absent",
  attendanceRecordedAt: "2026-10-20T10:00:00.000000Z",
  afterCloseReason: null,
  informedBasis: false,
  superseded: false,
  conflict: null,
  conflictResolution: null,
  followUpOf: null,
  missedResolution: null,
  missed,
  capabilities: {
    cancel: false,
    recordAttended: false,
    recordAbsent: false,
    offerInformed: false,
    afterClose: false,
    markInformed: false,
    confirmBasis: false,
    reviewConflict: false,
  },
});

const tab = (missed: { followUp: boolean; resolve: boolean } | null) => ({
  bookings: [missedBooking(missed)],
  bookable: [
    {
      appointment: summary(
        slotId,
        "consultation",
        "2026-11-03T08:00:00.000000Z",
        "2026-11-03T09:00:00.000000Z",
      ),
      availability: "available",
      code: null,
      warnings: [],
    },
    {
      appointment: summary(
        eventId,
        "info_event",
        "2026-11-04T08:00:00.000000Z",
        "2026-11-04T10:00:00.000000Z",
      ),
      availability: "available",
      code: null,
      warnings: [],
    },
  ],
  capabilities: { book: missed?.followUp ?? false },
});

function setup(missed: { followUp: boolean; resolve: boolean } | null) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/appointments`]: () => json(tab(missed)),
    [`POST /api/v1/appointments/${slotId}/bookings`]: () =>
      json({ bookingId: "00000000-0000-4000-a000-0000000000b2", warnings: [] }, 201),
    [`POST /api/v1/appointment-bookings/${missedId}/missed-resolution`]: () =>
      new Response(null, { status: 204 }),
  });
  renderApp(`/projects/${project.id}/participations/${participationId}?tab=appointments`, mock.api);
  return mock;
}

const bookingsTable = async () => within(await screen.findByRole("table", { name: "Buchungen" }));

describe("a missed appointment on the tab 'Termine'", () => {
  it("books a consultation as its follow-up, among the appointments of its kind", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ followUp: true, resolve: true });
    const row = (await (await bookingsTable()).findByText(/Nachverfolgung offen/)).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Folgetermin buchen" }));
    expect(
      screen.getByText(/Folgetermin für den versäumten Termin vom 20\.10\.2026/),
    ).toBeVisible();
    const bookable = screen.getByRole("table", { name: "Termin buchen" });
    // Only consultations follow up a consultation.
    expect(within(bookable).queryByText("Infoveranstaltung")).not.toBeInTheDocument();
    await user.click(within(bookable).getByRole("button", { name: "Buchen" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.key === `POST /api/v1/appointments/${slotId}/bookings`)?.body,
      ).toEqual({ participationId, followUpOf: missedId }),
    );
  });

  it("ends the follow-up with a closed reason", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ followUp: true, resolve: true });
    const row = (await (await bookingsTable()).findByText(/Nachverfolgung offen/)).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Keine weitere Nachverfolgung" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Keine weitere Nachverfolgung" });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "participant_declined");
    await user.click(submit);
    await waitFor(() =>
      expect(
        calls.find(
          (call) => call.key === `POST /api/v1/appointment-bookings/${missedId}/missed-resolution`,
        )?.body,
      ).toEqual({ reason: "participant_declined" }),
    );
  });

  it("offers neither action without the capability", async () => {
    setup({ followUp: false, resolve: false });
    const row = (await (await bookingsTable()).findByText(/Nachverfolgung offen/)).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Folgetermin buchen" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Keine weitere Nachverfolgung" })).toBeNull();
  });
});
