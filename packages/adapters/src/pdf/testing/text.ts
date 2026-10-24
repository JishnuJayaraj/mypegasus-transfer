import type { AnlageDocument } from "@transfer/domain";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * A rendered PDF's text as pdf.js reads it, and the text runs that end beyond their page's
 * right edge (content a reader would see cut off).
 */
export async function extractText(pdf: Uint8Array): Promise<{ text: string; beyondEdge: number }> {
  const task = getDocument({ data: new Uint8Array(pdf), verbosity: 0 });
  const doc = await task.promise;
  let text = "";
  let beyondEdge = 0;
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const [, , width] = page.view as [number, number, number, number];
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.str.trim() && item.transform[4] + item.width > width + 0.5) beyondEdge++;
    }
  }
  await task.destroy();
  return { text, beyondEdge };
}

export const count = (text: string, char: string) =>
  [...text].filter((each) => each === char).length;

/**
 * An Anlage with valid unbroken runs longer than any line: a 200-character employer (`Q`), a
 * 300-character text (`Z`), a long name (`N`) and heading (`H`) — letters no label contains.
 */
export const unbrokenAnlage: AnlageDocument = {
  template: "anlage-profilingbogen:v1",
  title: "Anlage zum Profilingbogen (TL 407 08/2025)",
  name: `Łucja Ayşe ${"N".repeat(150)}`,
  birthDate: "29.07.2051",
  sections: [
    {
      kind: "table",
      heading: "40 Beruflicher Werdegang",
      columns: ["Von", "Bis", "Beschäftigungsstelle", "Tätigkeit als"],
      rows: [["01.04.2088", "30.06.2088", "Q".repeat(200), "Lagerist"]],
    },
    { kind: "text", heading: `B. Weiteres Vorgehen ${"H".repeat(120)}`, text: "Z".repeat(300) },
  ],
};
