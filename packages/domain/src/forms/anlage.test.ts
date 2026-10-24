import { describe, expect, it } from "vitest";
import { escapeHtml, fillTemplate, renderAnlage } from "./anlage";
import type { AnlageDocument } from "./layout";

const template = {
  index: "<h1>{{title}}</h1><p>{{person}}</p>{{sections}}",
  header: "<p>{{title}}</p><p>{{person}}</p>",
  footer: '<p>Seite <span class="pageNumber"></span></p>',
};
const anlage: AnlageDocument = {
  template: "anlage-profilingbogen:v1",
  title: "Anlage zum Profilingbogen (TL 407 08/2025)",
  name: "Łucja <Doğan>",
  birthDate: "29.07.2051",
  sections: [
    { kind: "text", heading: "B. Weiteres Vorgehen", text: "Rest & mehr" },
    {
      kind: "table",
      heading: "40 Beruflicher Werdegang",
      columns: ["Von", "Bis"],
      rows: [["01.01.2090", ""]],
    },
  ],
};

describe("renderAnlage (ba-forms.md, overflow)", () => {
  it("puts the person on every page and each continuation under its heading, escaped", () => {
    const document = renderAnlage(template, anlage);
    expect(document.headerHtml).toBe(
      "<p>Anlage zum Profilingbogen (TL 407 08/2025)</p><p>Łucja &lt;Doğan&gt;, geb. 29.07.2051</p>",
    );
    expect(document.html).toContain(
      '<section><h2>B. Weiteres Vorgehen</h2><p class="text">Rest &amp; mehr</p></section>',
    );
    expect(document.html).toContain(
      "<table><thead><tr><th>Von</th><th>Bis</th></tr></thead><tbody><tr><td>01.01.2090</td><td></td></tr></tbody></table>",
    );
    expect(document.footerHtml).toBe(template.footer);
    expect(document.text).toEqual({
      pageHeader: ["Anlage zum Profilingbogen (TL 407 08/2025)", "Łucja <Doğan>, geb. 29.07.2051"],
      blocks: [
        { kind: "heading", text: "B. Weiteres Vorgehen" },
        { kind: "paragraph", text: "Rest & mehr" },
        { kind: "heading", text: "40 Beruflicher Werdegang" },
        { kind: "table", columns: ["Von", "Bis"], rows: [["01.01.2090", ""]] },
      ],
    });
  });

  it("names the person without a birth date when it is missing", () => {
    expect(renderAnlage(template, { ...anlage, birthDate: "" }).text.pageHeader[1]).toBe(
      "Łucja <Doğan>",
    );
  });
});

describe("fillTemplate", () => {
  it("refuses a placeholder without a value and a value without its placeholder", () => {
    expect(() => fillTemplate("{{a}}", {})).toThrow("without a value: a");
    expect(() => fillTemplate("{{a}}", { a: "x", b: "y" })).toThrow("lacks placeholders: b");
    expect(fillTemplate("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });

  it("escapes the HTML specials", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
