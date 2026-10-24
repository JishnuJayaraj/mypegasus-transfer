import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { mappedFieldNames, printableRanges, type FieldMap } from "@transfer/domain";
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import { fontsDir, listFormVersions, loadFont, loadFormVersion } from "./load";

// The registry (ADR-0009): each version folder's files agree, its blank is the BA's unchanged
// download (no values, no XFA), and its field map matches the blank field by field.

const versions = listFormVersions();

const daSize = (dict: { lookup(key: PDFName): unknown }) =>
  / ([0-9.]+) Tf/.exec(String(dict.lookup(PDFName.of("DA")) ?? ""))?.[1];

/** The text size of the field's `DA`, or of each widget's where the field has none. */
const daFontSizes = (field: PDFField) => {
  const own = daSize(field.acroField.dict);
  if (own !== undefined) return [Number(own)];
  return field.acroField.getWidgets().map((widget) => Number(daSize(widget.dict)));
};
const sizes = (field: PDFField, expected: number) =>
  daFontSizes(field).every((size) => size === expected);
const onStates = (field: PDFField) =>
  field.acroField.getWidgets().map((widget) => widget.getOnValue()?.decodeText());

async function pdfFields(blank: Uint8Array) {
  const doc = await PDFDocument.load(blank, { updateMetadata: false });
  const fields = new Map(
    doc
      .getForm()
      .getFields()
      .map((field) => [field.getName(), field]),
  );
  return { doc, fields };
}

/** Every AcroForm field a map entry or column names, with the entry that names it. */
function entriesByField(map: FieldMap) {
  return map.entries.flatMap((entry) =>
    (entry.kind === "table" ? entry.columns : [entry]).map((column) => ({
      column,
      names: column.fields,
    })),
  );
}

/** Where a map's entries disagree with the blank's fields, as readable lines. */
function fieldMismatches(map: FieldMap, fields: Map<string, PDFField>): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  for (const { column, names } of entriesByField(map)) {
    for (const name of names) {
      const field = fields.get(name)!;
      const at = `${column.key} ${name}`;
      const isText = field instanceof PDFTextField;
      switch (column.kind) {
        case "text":
          check(isText && field.isMultiline() === column.multiline, `${at}: text, multiline`);
          check(sizes(field, column.fontSize ?? map.fontSize), `${at}: font size`);
          for (const widget of field.acroField.getWidgets()) {
            const { width, height } = widget.getRectangle();
            check(
              width >= column.box.width - 0.01 && height >= column.box.height - 0.01,
              `${at}: box`,
            );
            // the layout's inset assumes a 1 pt border
            check(widget.getBorderStyle()?.getWidth() === 1, `${at}: border`);
          }
          break;
        case "date":
        case "time":
          check(isText && sizes(field, map.fontSize), `${at}: ${column.kind} text field`);
          break;
        case "radio":
          check(
            field instanceof PDFRadioGroup &&
              JSON.stringify(Object.values(column.options).toSorted()) ===
                JSON.stringify(field.getOptions().toSorted()),
            `${at}: radio options`,
          );
          break;
        case "checkbox":
          check(
            field instanceof PDFCheckBox &&
              JSON.stringify(onStates(field)) === JSON.stringify([column.onState]),
            `${at}: checkbox on-state`,
          );
          break;
        case "checkbox_choice":
          check(
            field instanceof PDFCheckBox &&
              JSON.stringify(onStates(field)) === JSON.stringify(Object.values(column.options)),
            `${at}: checkbox on-states`,
          );
          break;
      }
    }
    if (column.kind === "text") {
      const rectangles = names.flatMap((name) =>
        fields
          .get(name)!
          .acroField.getWidgets()
          .map((widget) => widget.getRectangle()),
      );
      const smallest = (pick: (r: { width: number; height: number }) => number) =>
        Math.min(...rectangles.map(pick));
      check(
        Math.abs(column.box.width - smallest((r) => r.width)) < 0.01 &&
          Math.abs(column.box.height - smallest((r) => r.height)) < 0.01,
        `${column.key}: box is the smallest widget`,
      );
    }
  }
  return problems;
}

describe("form registry (ADR-0009)", () => {
  it("holds the TL 407, the Kug 200b and the Kug 200a", () => {
    expect(versions).toEqual([
      { formCode: "kug200a", version: "07-2025" },
      { formCode: "kug200b", version: "09-2021" },
      { formCode: "tl407", version: "08-2025" },
    ]);
  });

  describe.each(versions)("$formCode $version", ({ formCode, version }) => {
    const { manifest, source, fieldMap, blank } = loadFormVersion(formCode, version);

    it("is the unchanged blank its source.json describes: pages, fields, no value, no XFA", async () => {
      const { doc, fields } = await pdfFields(blank);
      expect(doc.getPageCount()).toBe(source.pages);
      expect(fields.size).toBe(source.acroFormFields);
      const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
      expect(acroForm.has(PDFName.of("XFA"))).toBe(false);
      const filled = [...fields.values()].filter((field) => {
        const value = field.acroField.dict.lookup(PDFName.of("V"));
        const states = field.acroField.getWidgets().map((widget) => widget.getAppearanceState());
        return (
          (value !== undefined && value !== PDFName.of("Off")) ||
          states.some((state) => state !== undefined && state !== PDFName.of("Off"))
        );
      });
      expect(filled.map((field) => field.getName())).toEqual([]);
      expect(manifest).toMatchObject({ validFrom: null, validUntil: null, validitySource: null });
    });

    it("maps every field of the blank once: filled or deliberately left blank", async () => {
      const { fields } = await pdfFields(blank);
      const mapped = mappedFieldNames(fieldMap);
      expect(mapped.toSorted()).toEqual([...fields.keys()].toSorted());
    });

    it("matches each field's kind, options, on-states, box and font size", async () => {
      const { fields } = await pdfFields(blank);
      expect(fieldMismatches(fieldMap, fields)).toEqual([]);
    });
  });

  it("names the TL 407's applicable `*` fields as the form marks them", () => {
    const { fieldMap } = loadFormVersion("tl407", "08-2025");
    const required = fieldMap.entries.filter((entry) => entry.required).map((entry) => entry.key);
    expect(required).toEqual([
      "carrier.name",
      "carrier.street",
      "carrier.postalCode",
      "carrier.city",
      "firstName",
      "lastName",
      "birthDate",
      "beeFrom",
      "beeTo",
      "pensionInsuranceNumber",
      "gender",
      "street",
      "postalCode",
      "city",
      "maritalStatus",
      "nationality",
      "unemployedFrom",
      "buergergeld",
      "healthRestrictions",
      "severeDisability",
      "education",
      "work",
      "germanLevel",
      "drivingLicence",
      "vehicleAvailable",
      "employmentType",
      "workingTimeDistribution",
      "desiredJob",
      "desiredWorkLocations",
      "maxDistanceKm",
      "maxDistanceScope",
      "jobboerseChoice",
      "earliestStartDate",
    ]);
    const tgOnly = fieldMap.entries.filter(
      (entry) => entry.kind !== "table" && entry.applies === "ta_tg",
    );
    expect(tgOnly.map((entry) => entry.key)).toEqual(["paragraph111", "beeFrom", "beeTo"]);
  });

  it("never fills the Vermerke, the signatures' places and dates, or the health line's text", () => {
    expect(loadFormVersion("tl407", "08-2025").fieldMap.neverFilled).toEqual([
      { field: "txtfVermerkKdNr", reason: "agentur" },
      { field: "txtfVermerkOrg", reason: "agentur" },
      { field: "txtfPersonUnterschriftOrt", reason: "signature" },
      { field: "datePersonUnterschrift", reason: "signature" },
      { field: "txtfProfilersUnterschriftOrt", reason: "signature" },
      { field: "dateProfilersUnterschrift", reason: "signature" },
      { field: "txtfLeistungHandlungZ1", reason: "health_detail" },
    ]);
    expect(
      loadFormVersion("kug200b", "09-2021").fieldMap.neverFilled.map(
        ({ field }) => field.split("_")[0],
      ),
    ).toEqual(["13", "14", "15", "16", "17", "18", "19"]);
  });
});

describe("the embedded font (ba-forms.md; OFL)", () => {
  it("covers every code point the forms accept", () => {
    const font = fontkit.create(Buffer.from(loadFont())) as unknown as {
      hasGlyphForCodePoint(codePoint: number): boolean;
    };
    const missing: string[] = [];
    for (const [from, to] of printableRanges) {
      for (let codePoint = from; codePoint <= to; codePoint++) {
        if (!font.hasGlyphForCodePoint(codePoint)) missing.push(codePoint.toString(16));
      }
    }
    expect(missing).toEqual([]);
  });

  it("ships its licence and provenance", () => {
    expect(readFileSync(new URL("OFL.txt", fontsDir), "utf8")).toContain("SIL Open Font License");
  });
});
