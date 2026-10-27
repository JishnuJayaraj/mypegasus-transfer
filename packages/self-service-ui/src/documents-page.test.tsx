import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentList, DocumentView, MissingItem } from "@transfer/domain";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./documents-page";
import type { DocumentSource } from "./documents";
import { emptyDocuments, fakeDocuments, refused, testI18n } from "./testing/render";

// "Unterlagen" (data-protection.md, documents and uploads): sections per type, the review
// states, the upload with its checks and busy state, the messages per code, opening as a
// download and deleting after a confirmation. Synthetic data only.

const types = ["cv", "participant_upload", "qualification_certificate"] as const;

const document = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  id: "00000000-0000-4000-d000-000000000001",
  type: "cv",
  mediaType: "application/pdf",
  sizeBytes: 250 * 1024,
  fileName: "lebenslauf-beispiel.pdf",
  addedAt: "2026-10-22T08:15:00.000Z",
  addedBy: "participant",
  onBehalf: false,
  review: { state: "unreviewed", reasonCode: null, reviewedAt: null },
  quarantine: null,
  capabilities: {
    open: true,
    review: false,
    delete: true,
    quarantine: false,
    liftQuarantine: false,
  },
  ...overrides,
});

const rejected = document({
  id: "00000000-0000-4000-d000-000000000002",
  type: "qualification_certificate",
  fileName: "zeugnis-beispiel.jpg",
  mediaType: "image/jpeg",
  sizeBytes: Math.round(1.2 * 1024 * 1024),
  addedBy: "staff",
  review: { state: "rejected", reasonCode: "unreadable", reviewedAt: "2026-10-22T09:00:00.000Z" },
});

const pdf = (name = "lebenslauf.pdf", bytes = 1200) =>
  new File([new Uint8Array(bytes).fill(0x25)], name, { type: "application/pdf" });

function setup(
  options: {
    list?: DocumentList;
    source?: Partial<DocumentSource>;
    missing?: MissingItem[];
    language?: "de" | "en";
    noRemove?: boolean;
  } = {},
) {
  const fake = fakeDocuments(options.list ?? emptyDocuments());
  const { remove, ...withoutRemove } = { ...fake, ...options.source };
  const source: DocumentSource = options.noRemove ? withoutRemove : { ...withoutRemove, remove };
  const onChanged = vi.fn<() => void>();
  const onExpired = vi.fn<() => void>();
  const assign = vi.fn<(url: string) => void>();
  const i18n = testI18n();
  if (options.language) void i18n.changeLanguage(options.language);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <DocumentsPage
          source={source}
          types={types}
          missing={options.missing ?? []}
          onChanged={onChanged}
          onExpired={onExpired}
          assign={assign}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { source: fake, onChanged, onExpired, assign };
}

describe("the documents page", () => {
  it("lists the documents per type with their state, and asks for no health documents", async () => {
    setup({ list: { ...emptyDocuments(), documents: [document(), rejected] } });
    const cv = await screen.findByRole("region", { name: "Lebenslauf" });
    expect(within(cv).getByText("lebenslauf-beispiel.pdf")).toBeInTheDocument();
    expect(
      within(cv).getByText(/^250 kB · hinzugefügt am 22\.10\.2026, 10:15 von Ihnen$/),
    ).toBeInTheDocument();
    expect(within(cv).getByText("hochgeladen")).toBeInTheDocument();
    const certificates = screen.getByRole("region", { name: "Zeugnisse und Nachweise" });
    expect(within(certificates).getByText("abgelehnt: nicht lesbar")).toBeInTheDocument();
    expect(within(certificates).getByText(/^1,2 MB · .* vom Beratungsteam$/)).toBeInTheDocument();
    const other = screen.getByRole("region", { name: "Sonstige Unterlagen" });
    expect(within(other).getByText("Noch keine Unterlage.")).toBeInTheDocument();
    expect(screen.getByText(/keine Diagnosen, keine Atteste/)).toBeInTheDocument();
    expect(
      screen.getByText("Erlaubt sind PDF, JPG und PNG, höchstens 10 MB je Datei."),
    ).toBeInTheDocument();
  });

  it("names a missing document of the template's rules", async () => {
    setup({
      missing: [
        { step: "data_collection", ruleId: "r-cv", kind: "document", key: "cv", reason: "missing" },
      ],
    });
    const cv = await screen.findByRole("region", { name: "Lebenslauf" });
    expect(within(cv).getByText("Diese Unterlage wird noch benötigt.")).toBeInTheDocument();
  });

  it("offers an upload only for the addable types, PDF, JPG and PNG", async () => {
    setup({ list: { ...emptyDocuments(), addableTypes: ["cv"] } });
    const input = await screen.findByLabelText("Lebenslauf hochladen");
    expect(input).toHaveAttribute("accept", ".pdf,.jpg,.jpeg,.png");
    expect(screen.queryByLabelText("Sonstige Unterlagen hochladen")).toBeNull();
  });

  it("sends the file as base64 with its name, busy until the API answers", async () => {
    let answer!: (view: DocumentView) => void;
    const { source, onChanged } = setup({
      source: {
        upload: vi.fn<DocumentSource["upload"]>(
          () => new Promise<DocumentView>((resolve) => (answer = resolve)),
        ),
      },
    });
    await userEvent.upload(await screen.findByLabelText("Lebenslauf hochladen"), pdf());
    expect(await screen.findByText("Die Datei wird hochgeladen und geprüft …")).toBeInTheDocument();
    for (const type of ["Lebenslauf", "Sonstige Unterlagen", "Zeugnisse und Nachweise"]) {
      expect(screen.getByLabelText(`${type} hochladen`)).toBeDisabled();
    }
    answer(document());
    expect(await screen.findByText("Die Datei wurde hochgeladen.")).toBeInTheDocument();
    expect(screen.queryByText("Die Datei wird hochgeladen und geprüft …")).toBeNull();
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("sends exactly the file's bytes", async () => {
    const upload = vi.fn<DocumentSource["upload"]>(async () => document());
    setup({ source: { upload } });
    await userEvent.upload(
      await screen.findByLabelText("Lebenslauf hochladen"),
      new File(["%PDF-1.7 Beispiel"], "lebenslauf.pdf"),
    );
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0]![0]).toEqual({
      type: "cv",
      fileName: "lebenslauf.pdf",
      content: btoa("%PDF-1.7 Beispiel"),
    });
  });

  it("refuses a file over the limit or an empty one before sending anything", async () => {
    const { source } = setup();
    const input = await screen.findByLabelText("Lebenslauf hochladen");
    await userEvent.upload(input, pdf("gross.pdf", 10 * 1024 * 1024 + 1));
    expect(await screen.findByText("Datei zu groß (höchstens 10 MB).")).toBeInTheDocument();
    await userEvent.upload(input, pdf("leer.pdf", 0));
    expect(await screen.findByText("Die Datei ist leer.")).toBeInTheDocument();
    expect(source.upload).not.toHaveBeenCalled();
  });

  it.each([
    [
      422,
      "file_infected",
      "Die Datei wurde nicht angenommen, weil sie Schadsoftware enthalten könnte.",
    ],
    [422, "file_type_not_allowed", "Nur PDF, JPG oder PNG."],
    [422, "file_unscannable", /mit einem Passwort geschützt/],
    [422, "document_limit", /zu viele Unterlagen gespeichert/],
    [422, "participation_closed", /Ihre Teilnahme ist abgeschlossen/],
    [400, "file_name_invalid", /Bitte benennen Sie die Datei um/],
    [429, "rate_limited", /In der letzten Stunde wurden zu viele Dateien hochgeladen/],
    [503, "upload_busy", /Gerade werden viele Dateien hochgeladen/],
    [503, "scan_unavailable", /Die Prüfung der Datei ist gerade nicht möglich/],
    [503, "storage_unavailable", /können gerade nicht gespeichert/],
    [500, "internal", "Das hat nicht geklappt. Bitte versuchen Sie es erneut."],
  ])("says what a %i %s means", async (status, code, message) => {
    const { onChanged } = setup({
      source: {
        upload: vi.fn<DocumentSource["upload"]>(async () => {
          throw refused(status, code);
        }),
      },
    });
    await userEvent.upload(await screen.findByLabelText("Lebenslauf hochladen"), pdf());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(message)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ends the page when the session has ended", async () => {
    const { onExpired } = setup({
      source: {
        upload: vi.fn<DocumentSource["upload"]>(async () => {
          throw refused(401, "unauthenticated");
        }),
      },
    });
    await userEvent.upload(await screen.findByLabelText("Lebenslauf hochladen"), pdf());
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });

  it("opens a document by its link: posts the opening, then navigates there", async () => {
    const { source, assign } = setup({ list: { ...emptyDocuments(), documents: [document()] } });
    await userEvent.click(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }),
    );
    expect(source.open).toHaveBeenCalledWith("00000000-0000-4000-d000-000000000001");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/api/v1/document-content/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    );
  });

  it("deletes only after the confirmation", async () => {
    const user = userEvent.setup();
    const { source, onChanged } = setup({ list: { ...emptyDocuments(), documents: [document()] } });
    await user.click(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf löschen" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Unterlage löschen?" });
    expect(within(dialog).getByText(/„lebenslauf-beispiel.pdf“ wird gelöscht/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(source.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "lebenslauf-beispiel.pdf löschen" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Unterlage löschen?" })).getByRole("button", {
        name: "Löschen",
      }),
    );
    expect(source.remove).toHaveBeenCalledWith("00000000-0000-4000-d000-000000000001");
    expect(await screen.findByText("Die Unterlage wurde gelöscht.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("follows the capabilities, and offers no deletion without one in the source", async () => {
    const locked = document({
      capabilities: {
        open: false,
        review: false,
        delete: false,
        quarantine: false,
        liftQuarantine: false,
      },
    });
    setup({ list: { ...emptyDocuments(), documents: [locked] } });
    await screen.findByText("lebenslauf-beispiel.pdf");
    expect(screen.queryByRole("button", { name: /öffnen$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /löschen$/ })).toBeNull();
  });

  it("offers no deletion in assisted mode (the source has none)", async () => {
    setup({ list: { ...emptyDocuments(), documents: [document()] }, noRemove: true });
    expect(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /löschen$/ })).toBeNull();
  });

  it("reloads the list when a document is gone", async () => {
    const { source } = setup({
      list: { ...emptyDocuments(), documents: [document()] },
      source: {
        open: vi.fn<DocumentSource["open"]>(async () => {
          throw refused(404, "not-found");
        }),
      },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "lebenslauf-beispiel.pdf öffnen" }),
    );
    expect(await screen.findByText("Diese Unterlage gibt es nicht mehr.")).toBeInTheDocument();
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it("speaks English", async () => {
    setup({ language: "en", list: { ...emptyDocuments(), documents: [rejected] } });
    const certificates = await screen.findByRole("region", { name: "Certificates and references" });
    expect(within(certificates).getByText("rejected: not readable")).toBeInTheDocument();
    expect(
      within(certificates).getByText(/^1\.2 MB · added on .* by the counselling team$/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Upload CV")).toBeInTheDocument();
    expect(screen.getByText(/no diagnoses, no sick notes/)).toBeInTheDocument();
  });
});
