import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentNavigation } from "./components/documents-tab";
import {
  json,
  mockApi,
  problem,
  project,
  renderApp,
  staffUsers,
  unpinnedConfig,
} from "./test-utils";

// The tab "Unterlagen" and the assisted wizard's "Unterlagen" page (data-protection.md, documents;
// ADR-0007, documents in assisted mode): the capabilities decide every button, review and
// deletion name a reason, opening is a download from the opening's link. Synthetic data only.
afterEach(() => {
  vi.restoreAllMocks();
});

const participationId = "00000000-0000-4000-a000-000000000001";
const assistedModeId = "00000000-0000-4000-c000-000000000001";
const projectPath = `/api/v1/projects/${project.id}`;
const detailPath = `/api/v1/participations/${participationId}`;
const pagePath = `/projects/${project.id}/participations/${participationId}`;
const cvId = "00000000-0000-4000-d000-000000000001";
const certificateId = "00000000-0000-4000-d000-000000000002";

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
  person: { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" },
  assignments: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: { state: "due", dueOn: "2026-11-15", providedAt: null },
  capabilities: {
    assignEntryWave: false,
    setParticipationDates: false,
    assignParticipations: false,
    issueActivationCode: false,
    recordHandover: false,
    revokeActivationCode: false,
    providePrivacyNotice: false,
    setPlacementAgentur: false,
    startAssistedMode: true,
    viewProfiling: false,
  },
  refusals: { assignEntryWave: null, setParticipationDates: null },
};

const all = { open: true, review: true, delete: true };
const none = { open: false, review: false, delete: false };

const cv = (capabilities = all) => ({
  id: cvId,
  type: "cv",
  mediaType: "application/pdf",
  sizeBytes: 250 * 1024,
  fileName: "lebenslauf-beispiel.pdf",
  addedAt: "2026-10-22T08:15:00.000Z",
  addedBy: "participant",
  onBehalf: false,
  review: { state: "unreviewed", reasonCode: null, reviewedAt: null },
  capabilities,
});

const certificate = {
  id: certificateId,
  type: "qualification_certificate",
  mediaType: "image/jpeg",
  sizeBytes: 2 * 1024 * 1024,
  fileName: "zeugnis-beispiel.jpg",
  addedAt: "2026-10-22T09:00:00.000Z",
  addedBy: "staff",
  onBehalf: true,
  review: { state: "rejected", reasonCode: "unreadable", reviewedAt: "2026-10-22T09:30:00.000Z" },
  quarantine: null,
  capabilities: {
    open: true,
    review: false,
    delete: true,
    quarantine: false,
    liftQuarantine: false,
  },
};

const list = (
  documents: object[] = [cv(), certificate],
  addableTypes = ["cv", "qualification_certificate"],
) => ({
  documents,
  addableTypes,
  limits: { maxBytes: 10 * 1024 * 1024, maxLiveDocuments: 50, maxUploadsPerHour: 20 },
});

function setup(routes: Parameters<typeof mockApi>[0] = {}, path = `${pagePath}?tab=documents`) {
  const mock = mockApi({
    "GET /api/v1/me": () => json(staffUsers[1]),
    "GET /api/v1/dev/staff-users": () => json(staffUsers),
    [`GET ${projectPath}`]: () => json(project),
    [`GET ${projectPath}/config`]: () => json(unpinnedConfig),
    [`GET ${projectPath}/entry-waves`]: () => json({ items: [], nextCursor: null }),
    [`GET ${detailPath}`]: () => json(detail),
    [`GET ${detailPath}/documents`]: () => json(list()),
    ...routes,
  });
  const { router } = renderApp(path, mock.api);
  return { ...mock, router };
}

const row = async (name: string) => (await screen.findByText(name)).closest("tr")!;

describe("the tab 'Unterlagen'", () => {
  it("lists Art, Datei, Größe, hinzugefügt am / von and the status", async () => {
    const user = userEvent.setup();
    setup({}, pagePath);
    await user.click(await screen.findByRole("tab", { name: "Unterlagen" }));
    for (const header of ["Art", "Datei", "Größe", "Hinzugefügt am / von", "Status"]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const first = await row("lebenslauf-beispiel.pdf");
    expect(within(first).getByText("Lebenslauf")).toBeInTheDocument();
    expect(within(first).getByText("250 kB")).toBeInTheDocument();
    expect(within(first).getByText("22.10.2026, 10:15 · Teilnehmer·in")).toBeInTheDocument();
    expect(within(first).getByText("hochgeladen")).toBeInTheDocument();
    const second = await row("zeugnis-beispiel.jpg");
    expect(within(second).getByText("Zeugnisse und Nachweise")).toBeInTheDocument();
    expect(within(second).getByText(/Team \(assistiert\)$/)).toBeInTheDocument();
    expect(within(second).getByText("abgelehnt: nicht lesbar")).toBeInTheDocument();
  });

  it("lets the capabilities decide every button", async () => {
    setup({ [`GET ${detailPath}/documents`]: () => json(list([cv(none), certificate], [])) });
    const first = await row("lebenslauf-beispiel.pdf");
    expect(within(first).queryAllByRole("button")).toEqual([]);
    const second = await row("zeugnis-beispiel.jpg");
    expect(
      within(second)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Öffnen", "Löschen"]);
    // Nothing addable: no "Unterlagen hinzufügen".
    expect(screen.queryByText("Unterlagen hinzufügen")).toBeNull();
  });

  it("opens a document: posts the opening, then follows its link", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(documentNavigation, "assign").mockImplementation(() => {});
    const token = "A".repeat(43);
    const { calls } = setup({
      [`POST ${detailPath}/documents/${cvId}/opening`]: () =>
        json({ url: `/api/v1/document-content/${token}`, expiresAt: "2026-10-22T10:01:00Z" }, 201),
    });
    await user.click(await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/api/v1/document-content/${token}`));
    expect(calls.map(({ key }) => key)).toContain(`POST ${detailPath}/documents/${cvId}/opening`);
  });

  it("accepts, and rejects only with a reason", async () => {
    const user = userEvent.setup();
    const reviewed = cv({ open: true, review: false, delete: true });
    const { calls } = setup({
      [`POST ${detailPath}/documents/${cvId}/review`]: () => json(reviewed),
    });
    await user.click(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf annehmen" }),
    );
    expect(await screen.findByText("Die Unterlage wurde angenommen.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "lebenslauf-beispiel.pdf ablehnen" }));
    const dialog = screen.getByRole("dialog", { name: "Unterlage ablehnen" });
    const submit = within(dialog).getByRole("button", { name: "Ablehnen" });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Grund"), "unreadable");
    await user.click(submit);
    expect(await screen.findByText("Die Unterlage wurde abgelehnt.")).toBeInTheDocument();
    const bodies = calls
      .filter(({ key }) => key === `POST ${detailPath}/documents/${cvId}/review`)
      .map(({ body }) => body);
    expect(bodies).toEqual([
      { decision: "accepted" },
      { decision: "rejected", reasonCode: "unreadable" },
    ]);
  });

  it("deletes with a reason after the confirmation", async () => {
    const user = userEvent.setup();
    let reason: string | null = null;
    setup({
      [`DELETE ${detailPath}/documents/${certificateId}`]: ({ query }) => {
        reason = query.get("reasonCode");
        return new Response(null, { status: 204 });
      },
    });
    await user.click(await screen.findByRole("button", { name: "zeugnis-beispiel.jpg löschen" }));
    const dialog = screen.getByRole("dialog", { name: "Unterlage löschen?" });
    expect(within(dialog).getByText(/„zeugnis-beispiel.jpg“ wird gelöscht/)).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Löschen" });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(reason).toBeNull();
    await user.click(screen.getByRole("button", { name: "zeugnis-beispiel.jpg löschen" }));
    const again = screen.getByRole("dialog", { name: "Unterlage löschen?" });
    await user.selectOptions(within(again).getByLabelText("Grund"), "wrong_person");
    await user.click(within(again).getByRole("button", { name: "Löschen" }));
    expect(await screen.findByText("Die Unterlage wurde gelöscht.")).toBeInTheDocument();
    expect(reason).toBe("wrong_person");
  });

  it("adds a document of a chosen type as base64, and says what a refusal means", async () => {
    const user = userEvent.setup();
    let refuse = false;
    const { calls } = setup({
      [`POST ${detailPath}/documents`]: () =>
        refuse
          ? problem(422, "domain-error", {
              errors: [{ pointer: "/content", code: "file_infected", detail: "x" }],
            })
          : json(certificate, 201),
    });
    await user.selectOptions(
      await screen.findByLabelText("Art der Unterlage"),
      "qualification_certificate",
    );
    const input = screen.getByLabelText("Datei auswählen");
    expect(input).toHaveAttribute("accept", ".pdf,.jpg,.jpeg,.png");
    await user.upload(input, new File(["%PDF-1.7 Beispiel"], "zeugnis.pdf"));
    expect(await screen.findByText("Die Unterlage wurde hinzugefügt.")).toBeInTheDocument();
    expect(calls.find(({ key }) => key === `POST ${detailPath}/documents`)?.body).toEqual({
      type: "qualification_certificate",
      fileName: "zeugnis.pdf",
      content: btoa("%PDF-1.7 Beispiel"),
    });
    refuse = true;
    await user.upload(input, new File(["%PDF-1.7 Beispiel"], "zeugnis.pdf"));
    expect(
      await screen.findByText(
        "Die Datei wurde nicht angenommen, weil sie Schadsoftware enthalten könnte.",
      ),
    ).toBeInTheDocument();
  });

  it("refuses a file over the limit before sending it", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.upload(
      await screen.findByLabelText("Datei auswählen"),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "gross.pdf"),
    );
    expect(await screen.findByText("Datei zu groß (höchstens 10 MB).")).toBeInTheDocument();
    expect(calls.map(({ key }) => key)).not.toContain(`POST ${detailPath}/documents`);
  });
});

describe("Unterlagen in assisted mode (ADR-0007)", () => {
  const assistedState = {
    participationId,
    assistedModeId,
    revision: 4,
    notice: { version: "self-service-purposes:v1", acknowledged: true },
    identity: { firstName: "Erika", lastName: "Mustermann", birthDate: "1970-01-01" },
    values: {},
    customValues: {},
    sensitive: {},
    pages: [
      {
        page: "documents",
        sensitive: false,
        complete: true,
        fields: [],
        documentTypes: ["cv", "participant_upload", "qualification_certificate"],
      },
    ],
    missing: [],
  };

  it("lists, adds on behalf and opens on the assisted routes; no deletion there", async () => {
    const user = userEvent.setup();
    const assisted = `${detailPath}/assisted/documents`;
    const { calls } = setup(
      {
        [`GET ${detailPath}/assisted/self-service`]: () => json(assistedState),
        [`GET ${assisted}`]: ({ query }) => {
          expect(query.get("assistedModeId")).toBe(assistedModeId);
          return json(list([cv({ open: true, review: true, delete: true })]));
        },
        [`POST ${assisted}`]: ({ query }) => {
          expect(query.get("assistedModeId")).toBe(assistedModeId);
          return json(cv(), 201);
        },
      },
      `${pagePath}/assisted?assistedModeId=${assistedModeId}&how=phone&step=documents`,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Unterlagen" })).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }),
    ).toBeInTheDocument();
    // Review and deletion stay on the tab.
    expect(screen.queryByRole("button", { name: /löschen$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /annehmen$/ })).toBeNull();
    await user.upload(
      screen.getByLabelText("Lebenslauf hochladen"),
      new File(["%PDF-1.7"], "lebenslauf.pdf"),
    );
    expect(await screen.findByText("Die Datei wurde hochgeladen.")).toBeInTheDocument();
    expect(calls.find(({ key }) => key === `POST ${assisted}`)?.body).toMatchObject({
      type: "cv",
      fileName: "lebenslauf.pdf",
    });
  });
});
