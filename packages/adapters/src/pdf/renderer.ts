import type { PrintDocument } from "@transfer/domain";
import { fillAcroForm } from "./acroform";
import { GotenbergHtmlRenderer } from "./gotenberg";
import { MockHtmlRenderer } from "./mock";
import { PdfUnavailable, type HtmlRenderer, type PdfRenderer } from "./pdf-renderer";

/** Forms with pdf-lib in process; HTML through the given renderer, or `PdfUnavailable`. */
export class PdfLibRenderer implements PdfRenderer {
  constructor(
    private readonly font: Uint8Array,
    private readonly html?: HtmlRenderer,
  ) {}

  fillForm(input: Parameters<PdfRenderer["fillForm"]>[0]): Promise<Uint8Array> {
    return fillAcroForm(this.font, input);
  }

  async renderHtml(document: PrintDocument): Promise<Uint8Array> {
    if (!this.html) throw new PdfUnavailable();
    return this.html.render(document);
  }
}

/**
 * The renderer `PDF_ADAPTER` selects (ADR-0006): `gotenberg` (needs `GOTENBERG_URL`) or `mock`.
 * In production `mock` wires no HTML renderer, so `renderHtml` throws `PdfUnavailable` and the
 * API answers `503 pdf_unavailable`; filling forms needs no service.
 */
export function createPdfRenderer(options: {
  adapter: string;
  gotenbergUrl?: string | undefined;
  production: boolean;
  font: Uint8Array;
}): PdfRenderer {
  switch (options.adapter) {
    case "gotenberg":
      if (!options.gotenbergUrl) throw new Error("PDF_ADAPTER=gotenberg needs GOTENBERG_URL");
      return new PdfLibRenderer(
        options.font,
        new GotenbergHtmlRenderer({ url: options.gotenbergUrl }),
      );
    case "mock":
      return new PdfLibRenderer(
        options.font,
        options.production ? undefined : new MockHtmlRenderer(options.font),
      );
    default:
      throw new Error("PDF_ADAPTER must be mock or gotenberg");
  }
}
