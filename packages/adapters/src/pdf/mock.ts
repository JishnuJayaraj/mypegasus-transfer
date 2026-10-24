import fontkit from "@pdf-lib/fontkit";
import type { PrintDocument, TextBlock } from "@transfer/domain";
import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type { HtmlRenderer } from "./pdf-renderer";

// Development and tests: the document's structured text drawn with pdf-lib, no browser, no
// network. Never wired with NODE_ENV=production.

const page = { width: 595.28, height: 841.89, margin: 50 };
const size = { header: 8, heading: 12, body: 10 };
const lineGap = 1.35;

/** A word wider than the line, in pieces that fit: nothing runs off the page. */
function pieces(word: string, font: PDFFont, fontSize: number, width: number): string[] {
  const parts: string[] = [];
  let part = "";
  for (const char of word) {
    if (part && font.widthOfTextAtSize(part + char, fontSize) > width) {
      parts.push(part);
      part = char;
    } else part += char;
  }
  return [...parts, part];
}

function wrapWords(text: string, font: PDFFont, fontSize: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    const words = paragraph.split(/\s+/).filter(Boolean);
    for (const word of words.flatMap((each) => pieces(each, font, fontSize, width))) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, fontSize) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const blockLines = (block: TextBlock): [string, number][] => {
  switch (block.kind) {
    case "heading":
      return [[block.text, size.heading]];
    case "paragraph":
      return [[block.text, size.body]];
    case "table":
      return [block.columns, ...block.rows].map((row) => [row.join(" | "), size.body]);
  }
};

export class MockHtmlRenderer implements HtmlRenderer {
  constructor(private readonly font: Uint8Array) {}

  async render(document: PrintDocument): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(this.font, { subset: false });
    const width = page.width - 2 * page.margin;
    const pages: PDFPage[] = [];
    let current!: PDFPage;
    let y = 0;
    const newPage = () => {
      current = doc.addPage([page.width, page.height]);
      pages.push(current);
      y = page.height - page.margin;
      for (const line of document.text.pageHeader.flatMap((text) =>
        wrapWords(text, font, size.header, width),
      )) {
        current.drawText(line, { x: page.margin, y, size: size.header, font });
        y -= size.header * lineGap;
      }
      y -= size.body;
    };
    newPage();
    for (const block of document.text.blocks) {
      for (const [text, fontSize] of blockLines(block)) {
        for (const line of wrapWords(text, font, fontSize, width)) {
          if (y < page.margin + size.body * 2) newPage();
          current.drawText(line, { x: page.margin, y, size: fontSize, font });
          y -= fontSize * lineGap;
        }
      }
      y -= size.body / 2;
    }
    pages.forEach((each, index) =>
      each.drawText(`Seite ${index + 1} von ${pages.length}`, {
        x: page.margin,
        y: page.margin / 2,
        size: size.header,
        font,
      }),
    );
    return doc.save();
  }
}
