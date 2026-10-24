import type { PrintDocument } from "@transfer/domain";
import { PdfUnavailable, type HtmlRenderer } from "./pdf-renderer";

// Gotenberg's Chromium HTML route (ADR-0006): a cluster-internal service (`GOTENBERG_URL`), so no
// third party sees the content. Index, header and footer go as files; A4 with room for the
// header and footer. Any failure is `PdfUnavailable`, never logged with content.

const a4 = { paperWidth: "8.27", paperHeight: "11.7" };
const margins = { marginTop: "1", marginBottom: "0.7", marginLeft: "0.6", marginRight: "0.6" };

export class GotenbergHtmlRenderer implements HtmlRenderer {
  constructor(
    private readonly options: { url: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async render(document: PrintDocument): Promise<Uint8Array> {
    const form = new FormData();
    const html = (content: string, name: string) =>
      form.append("files", new Blob([content], { type: "text/html" }), name);
    html(document.html, "index.html");
    html(document.headerHtml, "header.html");
    html(document.footerHtml, "footer.html");
    for (const [name, value] of Object.entries({ ...a4, ...margins })) form.append(name, value);
    const url = new URL("forms/chromium/convert/html", `${this.options.url.replace(/\/$/, "")}/`);
    // The body is read inside the boundary too: a stream that breaks or times out after the
    // headers is as unavailable as a refused connection.
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
      if (!response.ok) throw new PdfUnavailable();
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new PdfUnavailable();
    }
  }
}
