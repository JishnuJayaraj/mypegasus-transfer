import type { AnlageDocument } from "./layout";

// Our own printed documents (ADR-0009): an HTML template version from `packages/forms`
// (`templates/own/<name>/v<n>/`) with its content, and the same content as structured text for
// the PDF adapter's mock, which renders without a browser.

/** A document's text blocks, for a renderer without HTML. */
export type TextBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] };

export type TextDocument = {
  /** Repeated at the top of every page. */
  pageHeader: string[];
  blocks: TextBlock[];
};

/** What `PdfRenderer.renderHtml` receives: the page, its header and footer, and the same as text. */
export type PrintDocument = {
  html: string;
  headerHtml: string;
  footerHtml: string;
  text: TextDocument;
};

/** A template version's files; `{{name}}` placeholders, each one the template knows. */
export type HtmlTemplate = { index: string; header: string; footer: string };

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => escapes[char]!);
}

/** Fills `{{name}}` placeholders; a placeholder without a value, or a value never used, is an error. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const html = template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new RangeError(`Template placeholder without a value: ${name}`);
    used.add(name);
    return value;
  });
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length > 0) throw new RangeError(`Template lacks placeholders: ${unused.join(", ")}`);
  return html;
}

const rowsHtml = (cells: string[], tag: "td" | "th") =>
  `<tr>${cells.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;

/**
 * The Anlage zum Profilingbogen (ba-forms.md, overflow; Q182): the title, name and birth date on
 * every page (the header), "Seite n von m" (the footer), and each continued table or text under
 * its source heading. Every value is escaped; the template brings its own styles.
 */
export function renderAnlage(template: HtmlTemplate, anlage: AnlageDocument): PrintDocument {
  const person = anlage.birthDate ? `${anlage.name}, geb. ${anlage.birthDate}` : anlage.name;
  const sections = anlage.sections
    .map((section) => {
      const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
      if (section.kind === "text") {
        return `<section>${heading}<p class="text">${escapeHtml(section.text)}</p></section>`;
      }
      const head = `<thead>${rowsHtml(section.columns, "th")}</thead>`;
      const body = `<tbody>${section.rows.map((row) => rowsHtml(row, "td")).join("")}</tbody>`;
      return `<section>${heading}<table>${head}${body}</table></section>`;
    })
    .join("\n");
  const values = { title: escapeHtml(anlage.title), person: escapeHtml(person) };
  return {
    html: fillTemplate(template.index, { ...values, sections }),
    headerHtml: fillTemplate(template.header, values),
    footerHtml: fillTemplate(template.footer, {}),
    text: {
      pageHeader: [anlage.title, person],
      blocks: anlage.sections.flatMap((section): TextBlock[] => [
        { kind: "heading", text: section.heading },
        section.kind === "text"
          ? { kind: "paragraph", text: section.text }
          : { kind: "table", columns: section.columns, rows: section.rows },
      ]),
    },
  };
}
