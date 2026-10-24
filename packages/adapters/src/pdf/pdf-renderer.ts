import type { FieldMap, FilledField, PrintDocument } from "@transfer/domain";

/**
 * PDF generation (ADR-0006, ADR-0009): official forms are filled in process with pdf-lib and
 * flattened, with the committed Noto Sans subset embedded so names outside WinAnsi print; our
 * own documents are HTML templates rendered by Gotenberg's Chromium route (a cluster-internal
 * service). Production wires no mock: without Gotenberg `renderHtml` throws `PdfUnavailable`.
 */
export interface PdfRenderer {
  /**
   * Fills the blank with the laid-out fields (`layoutForm`) and flattens it unless `flatten` is
   * false (contract tests read the values back). A field the map never fills is refused.
   */
  fillForm(input: {
    template: Uint8Array;
    fieldMap: FieldMap;
    fields: readonly FilledField[];
    flatten?: boolean;
  }): Promise<Uint8Array>;
  renderHtml(document: PrintDocument): Promise<Uint8Array>;
}

/** HTML → PDF behind `PdfRenderer.renderHtml`. */
export interface HtmlRenderer {
  render(document: PrintDocument): Promise<Uint8Array>;
}

/** No HTML renderer is wired, or it can't be reached (`503 pdf_unavailable`). */
export class PdfUnavailable extends Error {
  constructor() {
    super("PDF rendering unavailable");
    this.name = "PdfUnavailable";
  }
}

/** A filled field the map doesn't allow; carries the field name, never a value. */
export class FormFillRefused extends Error {
  constructor(readonly field: string) {
    super(`Field not fillable: ${field}`);
    this.name = "FormFillRefused";
  }
}
