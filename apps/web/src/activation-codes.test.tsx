import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, mockApi, project, renderApp, staffUsers, unpinnedConfig } from "./test-utils";

vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,cXJjb2Rl") },
}));

const path = `/api/v1/projects/${project.id}`;
const participationId = "00000000-0000-4000-a000-000000000001";
const item = (code: "none" | "printed" | "open" = "none") => ({
  id: participationId,
  status: "imported",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  entryWaveId: null,
  personnelNumber: "BSP-0001",
  lastName: "Beispiel",
  firstName: "Erika",
  consultants: [],
  activationStatus: {
    account: "not_activated",
    code,
    issuedAt: code === "none" ? null : "2026-10-21T10:00:00.000Z",
    expiresAt: code === "none" ? null : "2026-11-20T10:00:00.000Z",
  },
  privacyNoticeState: { state: "due", dueOn: "2026-11-15", providedAt: null },
  activationCapabilities: {
    issueActivationCode: true,
    recordHandover: true,
    revokeActivationCode: true,
    providePrivacyNotice: true,
  },
});
const printItem = {
  activationCodeId: "00000000-0000-4000-c000-000000000001",
  participationId,
  firstName: "Erika",
  lastName: "Beispiel",
  address: {
    street: "Musterweg 1",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  },
  code: "0123-4567-89AB",
  activationUrl: "https://portal.example/activate#0123456789AB",
  expiresAt: "2026-11-20T10:00:00.000Z",
  noticeVersion: "art14-activation:v1",
  noticeLanguage: "de",
  noticeTitle: "Datenschutzhinweise nach Art. 14 DSGVO",
  noticeText: "Synthetischer Datenschutzhinweis.",
};

function setup(code: "none" | "printed" | "open" = "none") {
  const { api, calls } = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${path}`]: () => json({ ...project, status: "active" }),
    [`GET ${path}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${path}/config`]: () => json(unpinnedConfig),
    "GET /api/v1/config/templates": () => json({ items: [], nextCursor: null }),
    [`GET ${path}/participations`]: () => json({ items: [item(code)], nextCursor: null }),
    [`POST ${path}/activation-codes`]: () => json({ items: [printItem] }, 201),
    [`POST /api/v1/participations/${participationId}/activation-codes/handover`]: () => json({}),
  });
  renderApp(`/projects/${project.id}`, api);
  return calls;
}

describe("activation-code staff views", () => {
  it("shows activation and notice state, filters on the server, and prints an ephemeral letter", async () => {
    const calls = setup();
    expect(await screen.findByRole("cell", { name: "Kein Code" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Fällig bis 2026-11-15" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Aktivierungsstatus"), "none");
    await waitFor(() => {
      const request = calls.filter((call) => call.key === `GET ${path}/participations`).at(-1);
      expect(request).toBeDefined();
    });
    await userEvent.click(screen.getByLabelText("BSP-0001 auswählen"));
    await userEvent.click(screen.getByRole("button", { name: "Aktivierungsbriefe drucken" }));
    expect(await screen.findByText("0123-4567-89AB")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        Boolean(element?.tagName === "ADDRESS" && element.textContent?.includes("Musterweg 1")),
      ),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      key: `POST ${path}/activation-codes`,
      body: {
        participationIds: [participationId],
        channel: "letter",
        language: "de",
        replaceOpenCode: false,
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Druckansicht schließen und Codes verwerfen" }),
    );
    expect(screen.queryByText("0123-4567-89AB")).toBeNull();
  });

  it("requires conscious confirmation before reissuing an open code", async () => {
    setup("open");
    await screen.findByRole("cell", { name: "Code offen" });
    await userEvent.click(screen.getByLabelText("BSP-0001 auswählen"));
    const issue = screen.getByRole("button", { name: "Aktivierungsblätter drucken" });
    expect(issue).toBeDisabled();
    await userEvent.click(
      screen.getByLabelText("Offene Codes widerrufen und bewusst neu ausstellen"),
    );
    expect(issue).toBeEnabled();
  });

  it("records an ID-checked event handover for a printed sheet", async () => {
    const calls = setup();
    await screen.findByRole("cell", { name: "BSP-0001" });
    await userEvent.click(screen.getByLabelText("BSP-0001 auswählen"));
    await userEvent.click(screen.getByRole("button", { name: "Aktivierungsblätter drucken" }));
    const view = await screen.findByRole("region", { name: "Aktivierungsblätter und Übergabe" });
    await userEvent.click(within(view).getByRole("button", { name: "Ausweis geprüft, übergeben" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: `POST /api/v1/participations/${participationId}/activation-codes/handover`,
        body: { activationCodeId: printItem.activationCodeId },
      }),
    );
    expect(await within(view).findByText("Übergeben und protokolliert")).toBeInTheDocument();
  });
});
