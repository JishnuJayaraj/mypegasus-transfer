import { renderDsv, type DsvDocument } from "@transfer/domain";
import { loadFont, loadOwnTemplate } from "@transfer/forms/load";
import { describe, expect, it } from "vitest";
import { pageCount } from "./acroform";
import { GotenbergHtmlRenderer } from "./gotenberg";
import { MockHtmlRenderer } from "./mock";
import { count, extractText } from "./testing/text";

// The DSV template `dsv:v1` rendered (ADR-0006, ADR-0009; Slice 7 D1): the variable parts read back
// (`Ł`, `ğ`), the deadline printed, HTML in a value escaped, a missing value left as a line, an
// unbroken run longer than a line kept on the page, the sample stamp on every page. Against a real
// Gotenberg (CI's service container) when GOTENBERG_URL is set; the mock renders the same text.

const template = loadOwnTemplate("dsv:v1");

const document: DsvDocument = {
  firstName: "Łucja Ayşe",
  lastName: "Doğan-Großmann <b>fett</b>",
  birthDate: "2051-07-29",
  street: "Weißdornweg 7",
  postalCode: "99999",
  city: "Beispielstadt",
  country: null,
  customerName: "Beispiel Maschinenbau GmbH & Co. KG",
  company: {
    name: "Beispiel Transfer GmbH",
    street: "Musterstraße",
    houseNumber: "1",
    postalCode: "99998",
    city: "Musterstadt",
  },
  tgStart: "2091-04-01",
  tgEnd: "2092-03-31",
  offerDeadline: "2091-03-12",
};

/** Valid but extreme: an unbroken customer name and street longer than any line, no birth date. */
const overflowing: DsvDocument = {
  ...document,
  birthDate: null,
  customerName: "Q".repeat(200),
  street: `${"X".repeat(150)}straße 1`,
};

const flat = (text: string) => text.replace(/\s+/g, " ");
/** pdf.js joins wrapped lines without a space: compare without any whitespace. */
const tight = (text: string) => text.replace(/\s+/g, "");

describe("the DSV through the mock renderer", () => {
  it("prints the parties, dates and deadline as text", async () => {
    const pdf = await new MockHtmlRenderer(loadFont()).render(renderDsv(template, document));
    const { text, beyondEdge } = await extractText(pdf);
    expect(flat(text)).toContain("Łucja Ayşe Doğan-Großmann <b>fett</b>, geb. 29.07.2051");
    expect(flat(text)).toContain("Angebot gültig bis 12.03.2091");
    expect(beyondEdge).toBe(0);
  });
});

const renderer = () => new GotenbergHtmlRenderer({ url: process.env.GOTENBERG_URL! });

describe.skipIf(!process.env.GOTENBERG_URL)("Gotenberg contract: the DSV", () => {
  it("reads every variable part back, the deadline and the stamp on each page; HTML stays text", async () => {
    const pdf = await renderer().render(renderDsv(template, document));
    const pages = await pageCount(pdf);
    const text = tight((await extractText(pdf)).text);
    for (const expected of [
      "Łucja Ayşe Doğan-Großmann <b>fett</b>",
      "geboren am 29.07.2051",
      "Weißdornweg 7, 99999 Beispielstadt",
      "Beispiel Maschinenbau GmbH & Co. KG",
      "Musterstraße 1, 99998 Musterstadt",
      "vom 01.04.2091 bis zum 31.03.2092",
      "bis einschließlich 12.03.2091",
    ]) {
      expect(text).toContain(tight(expected));
    }
    // the header's and the watermark's stamp on every page
    expect(text.split(tight("MUSTER – NICHT ZUR VERWENDUNG")).length - 1).toBeGreaterThanOrEqual(
      2 * pages,
    );
  });

  it("keeps every character of unbroken runs on the page and leaves a line for a missing value", async () => {
    const pdf = await renderer().render(renderDsv(template, overflowing));
    const { text, beyondEdge } = await extractText(pdf);
    expect(count(text, "Q")).toBe(200);
    expect(count(text, "X")).toBe(150);
    expect(beyondEdge).toBe(0);
    expect(tight(text)).toContain("geborenamAnschrift:");
  });
});
