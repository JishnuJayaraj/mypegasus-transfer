import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  team,
  unpinnedConfig,
  worklist,
  worklistItem,
} from "./test-utils";

// Appointments in the staff app (process-and-lifecycle.md and data-protection.md, appointments):
// the project tab "Termine" with its form, and booking from the appointment page. Synthetic data
// only.
const projectPath = `/api/v1/projects/${project.id}`;
const appointmentId = "00000000-0000-4000-a000-0000000000a1";
const participationId = "00000000-0000-4000-a000-000000000001";

const appointment = (overrides: Record<string, unknown> = {}) => ({
  id: appointmentId,
  projectId: project.id,
  kind: "info_event",
  startsAt: "2091-02-10T09:00:00.000000Z",
  endsAt: "2091-02-10T11:00:00.000000Z",
  bookingClosesAt: "2091-02-09T09:00:00.000000Z",
  capacity: 40,
  title: null,
  venue: "Kantine Werk 2",
  hostStaffUserId: null,
  audienceWaveId: null,
  status: "scheduled",
  cancelReason: null,
  cancelledAt: null,
  inUse: false,
  version: 1,
  bookings: { scope: "all", booked: 12, availability: "available" },
  needsResolution: 0,
  capabilities: { change: true, changeHost: false, cancel: true, book: true },
  ...overrides,
});

const page = (items: object[], capabilities: Record<string, boolean>) => ({
  items,
  nextCursor: null,
  capabilities: {
    createInfoEvent: false,
    createConsultation: false,
    chooseHost: false,
    ...capabilities,
  },
});

function setup(path: string, routes: Parameters<typeof mockApi>[0] = {}) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/members`]: () => json(team),
    ...routes,
  });
  return { ...mock, ...renderApp(path, mock.api) };
}

describe("the project tab 'Termine'", () => {
  it("creates an info event from Berlin date and times, with the hint on personal data", async () => {
    const user = userEvent.setup();
    const { calls } = setup(`/projects/${project.id}?tab=appointments`, {
      [`GET ${projectPath}/appointments`]: () =>
        json(
          page([appointment()], {
            createInfoEvent: true,
            createConsultation: true,
            chooseHost: true,
          }),
        ),
      [`POST ${projectPath}/appointments`]: () => json(appointment(), 201),
    });
    const table = await screen.findByRole("table", { name: "Termine" });
    expect(within(table).getByText("12 von 40 · Plätze frei")).toBeInTheDocument();
    expect(within(table).getByText("10.02.2091, 10:00–12:00 Uhr")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Infoveranstaltung anlegen" }));
    expect(screen.getByText(/Keine Namen, Diagnosen oder Gesprächsnotizen/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Datum (TT.MM.JJJJ)"), "01.07.2091");
    await user.type(screen.getByLabelText("Beginn (HH:MM)"), "10:00");
    await user.type(screen.getByLabelText("Ende (HH:MM)"), "11:30");
    await user.type(screen.getByLabelText("Plätze (1–500)"), "40");
    await user.type(screen.getByLabelText("Ort"), "Kantine Werk 2");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(calls.find((call) => call.key === `POST ${projectPath}/appointments`)?.body).toEqual({
        kind: "info_event",
        startsAt: "2091-07-01T08:00:00.000Z",
        endsAt: "2091-07-01T09:30:00.000Z",
        bookingCutoffDays: 1,
        capacity: 40,
        title: null,
        venue: "Kantine Werk 2",
        audienceWaveId: null,
        hostStaffUserId: null,
      }),
    );
  });

  it("shows a consultant their own count and no info-event button", async () => {
    setup(`/projects/${project.id}?tab=appointments`, {
      [`GET ${projectPath}/appointments`]: () =>
        json(
          page(
            [
              appointment({
                bookings: { scope: "own", own: 3, availability: "full" },
                needsResolution: null,
              }),
            ],
            { createConsultation: true },
          ),
        ),
    });
    const table = await screen.findByRole("table", { name: "Termine" });
    expect(within(table).getByText("davon Ihre: 3 · ausgebucht")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Infoveranstaltung anlegen" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beratungstermin anlegen" })).toBeInTheDocument();
  });

  it("reads a 403 as not allowed", async () => {
    setup(`/projects/${project.id}?tab=appointments`, {
      [`GET ${projectPath}/appointments`]: () => problem(403, "forbidden"),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sie sehen die Termine dieses Projekts nicht.",
    );
  });
});

/** The appointment page's reads, and the booking's answer. */
const routes = (bookingResponse: () => Response) => ({
  [`GET /api/v1/appointments/${appointmentId}`]: () => json(appointment()),
  [`GET /api/v1/appointments/${appointmentId}/bookings`]: () => json({ items: [] }),
  [`GET ${projectPath}/worklist`]: () =>
    json(
      worklist([
        worklistItem({
          id: participationId,
          personnelNumber: "BSP-0001",
          lastName: "Beispiel",
          firstName: "Erika",
        }),
        worklistItem({
          id: "00000000-0000-4000-a000-000000000002",
          personnelNumber: "BSP-0002",
          lastName: "Muster",
          firstName: "Max",
          status: "withdrawn",
        }),
      ]),
    ),
  [`POST /api/v1/appointments/${appointmentId}/bookings`]: bookingResponse,
});

describe("the appointment page", () => {
  it("books a participant found by name and shows the warning", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      `/projects/${project.id}/appointments/${appointmentId}`,
      routes(() =>
        json(
          {
            bookingId: "00000000-0000-4000-a000-0000000000b1",
            warnings: [{ code: "beyond_upcoming_cutoff", latestEntryDate: "2091-02-05" }],
          },
          201,
        ),
      ),
    );
    await user.type(await screen.findByLabelText("Name oder Personalnummer"), "beisp");
    const choice = await screen.findByLabelText("Teilnehmende·r");
    // A closed participation isn't offered.
    expect(within(choice).queryByText(/Muster/)).not.toBeInTheDocument();
    await user.selectOptions(choice, participationId);
    await user.click(screen.getByRole("button", { name: "Buchen" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.key === `POST /api/v1/appointments/${appointmentId}/bookings`)
          ?.body,
      ).toEqual({ participationId }),
    );
    expect(
      await screen.findByText(/liegt nach dem letzten Eintrittsdatum \(05\.02\.2091\)/),
    ).toBeInTheDocument();
  });

  it("names a refusal", async () => {
    const user = userEvent.setup();
    setup(
      `/projects/${project.id}/appointments/${appointmentId}`,
      routes(() =>
        problem(422, "domain-error", {
          errors: [{ pointer: "", code: "appointment_full", detail: "Refused by a domain rule" }],
        }),
      ),
    );
    await user.type(await screen.findByLabelText("Name oder Personalnummer"), "BSP-0001");
    await user.selectOptions(await screen.findByLabelText("Teilnehmende·r"), participationId);
    await user.click(screen.getByRole("button", { name: "Buchen" }));
    expect(await screen.findByText("Ausgebucht.")).toBeInTheDocument();
  });
});

describe("changing a booked appointment", () => {
  it("sends only the corrected venue, never the frozen times", async () => {
    const user = userEvent.setup();
    const booked = appointment({ inUse: true, startsAt: "2091-02-10T09:00:30.000000Z" });
    const { calls } = setup(`/projects/${project.id}/appointments/${appointmentId}`, {
      [`GET /api/v1/appointments/${appointmentId}`]: () => json(booked),
      [`GET /api/v1/appointments/${appointmentId}/bookings`]: () => json({ items: [] }),
      [`GET ${projectPath}/worklist`]: () => json(worklist([])),
      [`PATCH /api/v1/appointments/${appointmentId}`]: () =>
        json({ ...booked, venue: "Raum 3", version: 2 }),
    });
    await user.click(await screen.findByRole("button", { name: "Ändern" }));
    expect(
      screen.getByText(/Zeiten, Buchungsschluss und Zielgruppe ändern sich nicht mehr/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Beginn (HH:MM)")).not.toBeInTheDocument();
    const venue = screen.getByLabelText("Ort");
    await user.clear(venue);
    await user.type(venue, "Raum 3");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.key === `PATCH /api/v1/appointments/${appointmentId}`)?.body,
      ).toEqual({ expectedVersion: 1, venue: "Raum 3" }),
    );
  });
});

/** A live booking on the appointment page, not yet recorded. */
const liveBooking = (overrides: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-a000-0000000000b1",
  participationId,
  personnelNumber: "BSP-0001",
  lastName: "Beispiel",
  firstName: "Erika",
  status: "booked",
  origin: "staff",
  bookedAt: "2091-02-01T09:00:00.000000Z",
  cancelReason: null,
  cancelledAt: null,
  needsResolution: null,
  attendance: null,
  attendanceRecordedAt: null,
  afterCloseReason: null,
  informedBasis: false,
  superseded: false,
  conflict: null,
  conflictResolution: null,
  capabilities: {
    cancel: false,
    recordAttended: true,
    recordAbsent: true,
    offerInformed: true,
    afterClose: false,
    markInformed: false,
    confirmBasis: false,
    reviewConflict: false,
  },
  ...overrides,
});

/** The appointment page of a started appointment of `kind` with one booking to record. */
function attendancePage(kind: "info_event" | "consultation") {
  const started = appointment({
    kind,
    hostStaffUserId: kind === "consultation" ? staffUsers[1]!.id : null,
    capabilities: {
      change: true,
      changeHost: false,
      cancel: true,
      book: false,
      recordAttendance: true,
      correctNotTakenPlace: false,
    },
  });
  return setup(`/projects/${project.id}/appointments/${appointmentId}`, {
    [`GET /api/v1/appointments/${appointmentId}`]: () => json(started),
    [`GET /api/v1/appointments/${appointmentId}/bookings`]: () => json({ items: [liveBooking()] }),
    [`GET ${projectPath}/worklist`]: () => json(worklist([])),
    [`POST /api/v1/appointments/${appointmentId}/attendance`]: () =>
      json({ recorded: 1, informed: 1, statusChanges: 1 }),
  });
}

describe("'Teilnahme erfassen' (process-and-lifecycle.md, appointments: attendance)", () => {
  it("never preselects 'als informiert erfassen' for a consultation", async () => {
    const user = userEvent.setup();
    attendancePage("consultation");
    await user.click(await screen.findByRole("button", { name: "Teilnahme erfassen" }));
    const dialog = await screen.findByRole("dialog", { name: "Teilnahme erfassen" });
    await user.selectOptions(
      within(dialog).getByLabelText("Teilnahme von Beispiel, Erika (BSP-0001)"),
      "attended",
    );
    expect(
      within(dialog).getByLabelText("Beispiel, Erika (BSP-0001) als informiert erfassen"),
    ).not.toBeChecked();
  });

  it("preselects it for an info event, and refuses a ticked row without the confirmation", async () => {
    const user = userEvent.setup();
    const { calls } = attendancePage("info_event");
    await user.click(await screen.findByRole("button", { name: "Teilnahme erfassen" }));
    const dialog = await screen.findByRole("dialog", { name: "Teilnahme erfassen" });
    await user.selectOptions(
      within(dialog).getByLabelText("Teilnahme von Beispiel, Erika (BSP-0001)"),
      "attended",
    );
    expect(
      within(dialog).getByLabelText("Beispiel, Erika (BSP-0001) als informiert erfassen"),
    ).toBeChecked();
    const confirmation = within(dialog).getByLabelText(
      "Die erforderlichen Informationen wurden vermittelt",
    );
    expect(confirmation).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    expect(
      await within(dialog).findByText(
        "Bitte bestätigen Sie, dass die erforderlichen Informationen vermittelt wurden.",
      ),
    ).toBeInTheDocument();
    const attendanceCall = `POST /api/v1/appointments/${appointmentId}/attendance`;
    expect(calls.some((call) => call.key === attendanceCall)).toBe(false);
    await user.click(confirmation);
    await user.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    await waitFor(() =>
      expect(calls.find((call) => call.key === attendanceCall)?.body).toEqual({
        entries: [{ participationId, attendance: "attended", markInformed: true }],
        informationDelivered: true,
        afterCloseReason: null,
      }),
    );
  });

  it("names each refused row after 'Keine Teilnahme erfasst'", async () => {
    const user = userEvent.setup();
    setup(`/projects/${project.id}/appointments/${appointmentId}`, {
      [`GET /api/v1/appointments/${appointmentId}`]: () =>
        json(
          appointment({
            capabilities: {
              change: false,
              changeHost: false,
              cancel: false,
              book: false,
              recordAttendance: true,
              correctNotTakenPlace: false,
            },
          }),
        ),
      [`GET /api/v1/appointments/${appointmentId}/bookings`]: () =>
        json({ items: [liveBooking()] }),
      [`GET ${projectPath}/worklist`]: () => json(worklist([])),
      [`POST /api/v1/appointments/${appointmentId}/attendance`]: () =>
        problem(422, "domain-error", {
          errors: [{ pointer: "/entries/0", code: "appointment_not_ended", detail: "Refused" }],
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Teilnahme erfassen" }));
    const dialog = await screen.findByRole("dialog", { name: "Teilnahme erfassen" });
    await user.selectOptions(
      within(dialog).getByLabelText("Teilnahme von Beispiel, Erika (BSP-0001)"),
      "absent",
    );
    await user.click(within(dialog).getByRole("button", { name: "Erfassen" }));
    expect(await within(dialog).findByText("Keine Teilnahme erfasst")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Beispiel, Erika (BSP-0001): „Nicht erschienen“ erst nach dem Ende des Termins.",
      ),
    ).toBeInTheDocument();
  });
});
