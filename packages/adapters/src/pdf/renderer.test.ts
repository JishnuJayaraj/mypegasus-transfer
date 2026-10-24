import { readFileSync } from "node:fs";
import { renderAnlage } from "@transfer/domain";
import { loadFont, loadFormVersion, loadOwnTemplate } from "@transfer/forms/load";
import { describe, expect, it } from "vitest";
import { pageCount } from "./acroform";
import { imageToPdf, mergePdfs } from "./compose";
import { PdfUnavailable } from "./pdf-renderer";
import { createPdfRenderer, PdfLibRenderer } from "./renderer";
import { count, extractText, unbrokenAnlage } from "./testing/text";

const font = loadFont();
const long = Array.from({ length: 60 }, (_, index) => `Zeile ${index + 1} der Fortsetzung`).join(
  "\n",
);
const anlage = renderAnlage(loadOwnTemplate("anlage-profilingbogen:v1"), {
  template: "anlage-profilingbogen:v1",
  title: "Anlage zum Profilingbogen (TL 407 08/2025)",
  name: "Łucja Ayşe Doğan-Großmann",
  birthDate: "29.07.2051",
  sections: [
    { kind: "text", heading: "B. Weiteres Vorgehen", text: long },
    {
      kind: "table",
      heading: "11 Zeiten",
      columns: ["Am", "Von", "Bis"],
      rows: [["20.02.2091", "09:00", "11:00"]],
    },
  ],
});
/** A synthetic JPEG: a blank form page at 1 dpi. */
const tinyJpeg = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQEAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAMAAkDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDbKozEZbgnqFwPpmrdVIAZJrlWPEcgVflHTaren+1VugD/2Q==",
    "base64",
  ),
);

describe("createPdfRenderer (ADR-0006)", () => {
  it("renders HTML with the mock outside production, page n of m on every page", async () => {
    const renderer = createPdfRenderer({ adapter: "mock", production: false, font });
    expect(await pageCount(await renderer.renderHtml(anlage))).toBe(2);
  });

  it("breaks unbroken runs longer than a line in the mock too, losing nothing", async () => {
    const renderer = createPdfRenderer({ adapter: "mock", production: false, font });
    const pdf = await renderer.renderHtml(
      renderAnlage(loadOwnTemplate("anlage-profilingbogen:v1"), unbrokenAnlage),
    );
    const { text, beyondEdge } = await extractText(pdf);
    // the name is in the page header and its continuation; the mock repeats the header per page
    expect(count(text, "Q")).toBe(200);
    expect(count(text, "Z")).toBe(300);
    expect(count(text, "H")).toBe(120);
    expect(count(text, "N") % 150).toBe(0);
    expect(beyondEdge).toBe(0);
  });

  it("wires no mock in production: renderHtml is unavailable, filling still works", async () => {
    const renderer = createPdfRenderer({ adapter: "mock", production: true, font });
    await expect(renderer.renderHtml(anlage)).rejects.toThrow(PdfUnavailable);
    const { blank, fieldMap } = loadFormVersion("kug200b", "09-2021");
    const filled = await renderer.fillForm({
      template: blank,
      fieldMap,
      fields: [{ name: "3_txtf_Vorname", kind: "text", value: "Łucja", fontSize: 9 }],
    });
    expect(await pageCount(filled)).toBe(1);
  });

  it("needs GOTENBERG_URL for gotenberg and refuses another adapter", () => {
    expect(
      createPdfRenderer({
        adapter: "gotenberg",
        gotenbergUrl: "http://gotenberg:3000",
        production: true,
        font,
      }),
    ).toBeInstanceOf(PdfLibRenderer);
    expect(() => createPdfRenderer({ adapter: "gotenberg", production: true, font })).toThrow(
      "GOTENBERG_URL",
    );
    expect(() => createPdfRenderer({ adapter: "weasyprint", production: false, font })).toThrow(
      "mock or gotenberg",
    );
  });
});

describe("compose helpers", () => {
  it("merges PDFs in order and turns a PNG or JPEG scan into an A4 page", async () => {
    const png = readFileSync(
      new URL("../../../../fixtures/documents/zeugnis-unscharf-beispiel.png", import.meta.url),
    );
    const pngPage = await imageToPdf(new Uint8Array(png), "image/png");
    const jpegPage = await imageToPdf(tinyJpeg, "image/jpeg");
    const { blank } = loadFormVersion("tl407", "08-2025");
    expect(await pageCount(await mergePdfs([blank, pngPage, jpegPage]))).toBe(9);
  });
});
