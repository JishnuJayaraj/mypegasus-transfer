import { renderAnlage, type PrintDocument } from "@transfer/domain";
import { loadOwnTemplate } from "@transfer/forms/load";
import { describe, expect, it } from "vitest";
import { pageCount } from "./acroform";
import { GotenbergHtmlRenderer } from "./gotenberg";
import { PdfUnavailable } from "./pdf-renderer";

const document = renderAnlage(loadOwnTemplate("anlage-profilingbogen:v1"), {
  template: "anlage-profilingbogen:v1",
  title: "Anlage zum Profilingbogen (TL 407 08/2025)",
  name: "Łucja Ayşe Doğan-Großmann",
  birthDate: "29.07.2051",
  sections: [
    { kind: "text", heading: "B. Weiteres Vorgehen", text: "Bewerbungstraining & Qualifizierung" },
    {
      kind: "table",
      heading: "40 Beruflicher Werdegang",
      columns: ["Von", "Bis", "Beschäftigungsstelle", "Tätigkeit als"],
      rows: [["01.04.2088", "30.06.2088", "Beispielbetrieb 1, Beispielstadt", "Lagerist"]],
    },
  ],
});

describe("GotenbergHtmlRenderer", () => {
  it("posts index, header and footer to the Chromium HTML route with A4 and margins", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetch = (async (url: URL, init: RequestInit) => {
      request = { url: String(url), init };
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const pdf = await new GotenbergHtmlRenderer({ url: "http://gotenberg:3000/", fetch }).render(
      document,
    );
    expect([...pdf]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(request!.url).toBe("http://gotenberg:3000/forms/chromium/convert/html");
    expect(request!.init.method).toBe("POST");
    const form = request!.init.body as FormData;
    const files = form.getAll("files") as File[];
    expect(files.map((file) => file.name)).toEqual(["index.html", "header.html", "footer.html"]);
    expect(await files[1]!.text()).toBe(document.headerHtml);
    expect([form.get("paperWidth"), form.get("paperHeight"), form.get("marginTop")]).toEqual([
      "8.27",
      "11.7",
      "1",
    ]);
  });

  it("answers PdfUnavailable when Gotenberg refuses or can't be reached", async () => {
    const refusing = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    for (const fetch of [refusing, failing]) {
      await expect(
        new GotenbergHtmlRenderer({ url: "http://gotenberg:3000", fetch }).render(document),
      ).rejects.toThrow(PdfUnavailable);
    }
  });
});

// Against a real Gotenberg (CI's service container); skipped without GOTENBERG_URL.
describe.skipIf(!process.env.GOTENBERG_URL)("Gotenberg contract", () => {
  it("renders the Anlage template to a PDF", async () => {
    const renderer = new GotenbergHtmlRenderer({ url: process.env.GOTENBERG_URL! });
    const pdf = await renderer.render(document satisfies PrintDocument);
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });
});
