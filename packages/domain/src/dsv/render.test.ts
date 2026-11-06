import { describe, expect, it } from "vitest";
import { renderDsv, type DsvDocument } from "./render";

const template = {
  index:
    "<p>{{participant}} {{birthDate}} {{address}} {{customer}} {{company}} {{companyAddress}} {{tgStart}} {{tgEnd}} {{offerDeadline}}</p>",
  header: "<p>{{person}}</p>",
  footer: "<p>Seite</p>",
};

const document: DsvDocument = {
  firstName: "Łucja Ayşe",
  lastName: "Doğan-Großmann <b>",
  birthDate: "2051-07-29",
  street: "Weißdornweg 7",
  postalCode: "99999",
  city: "Beispielstadt",
  country: "DE",
  customerName: 'Beispiel & "Co"',
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

describe("renderDsv", () => {
  it("fills the variable parts, every value escaped, dates as TT.MM.JJJJ", () => {
    const rendered = renderDsv(template, document);
    expect(rendered.html).toBe(
      "<p>Łucja Ayşe Doğan-Großmann &lt;b&gt; 29.07.2051 Weißdornweg 7, 99999 Beispielstadt Beispiel &amp; &quot;Co&quot; Beispiel Transfer GmbH Musterstraße 1, 99998 Musterstadt 01.04.2091 31.03.2092 12.03.2091</p>",
    );
    expect(rendered.headerHtml).toBe("<p>Łucja Ayşe Doğan-Großmann &lt;b&gt;</p>");
    expect(rendered.footerHtml).toBe("<p>Seite</p>");
    expect(rendered.text.pageHeader[1]).toBe("Łucja Ayşe Doğan-Großmann <b>");
    expect(rendered.text.blocks).toContainEqual({
      kind: "paragraph",
      text: "Beginn 01.04.2091, Ende 31.03.2092. Angebot gültig bis 12.03.2091.",
    });
  });

  it("prints a line for an absent birth date and address, the country when known", () => {
    const blank = renderDsv(template, {
      ...document,
      birthDate: null,
      street: null,
      postalCode: null,
      city: null,
    });
    expect(blank.html).toContain(
      'Doğan-Großmann &lt;b&gt; <span class="blank"></span> <span class="blank"></span> Beispiel',
    );
    expect(blank.text.blocks[1]).toMatchObject({
      rows: [
        ["Arbeitnehmer·in", "Łucja Ayşe Doğan-Großmann <b>, geb. ________________"],
        ["Anschrift", "________________"],
        expect.anything(),
        expect.anything(),
      ],
    });
    const abroad = renderDsv(template, { ...document, postalCode: null, country: "PL" });
    expect(abroad.html).toContain("Weißdornweg 7, Beispielstadt, PL");
    const unknown = renderDsv(template, { ...document, country: null });
    expect(unknown.html).toContain("Weißdornweg 7, 99999 Beispielstadt Beispiel");
  });
});
