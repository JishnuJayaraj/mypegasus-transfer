import { readFileSync } from "node:fs";
import {
  addDays,
  addMonths,
  checkFilledFields,
  kug200bInput,
  layoutForm,
  layoutTl407,
  renderAnlage,
  tl407Input,
  validateFormInput,
  type FieldMap,
  type FilledField,
  type FormInput,
  type TextMeasure,
} from "@transfer/domain";
import { syntheticKug200b, syntheticTl407 } from "@transfer/domain/testing/forms";
import { loadFont, loadFormVersion, loadOwnTemplate } from "@transfer/forms/load";
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFStream } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { createTextMeasure, fillAcroForm, pageCount, readAcroFormValues } from "./acroform";
import { mergePdfs } from "./compose";
import { MockHtmlRenderer } from "./mock";
import { FormFillRefused } from "./pdf-renderer";

// Contract tests on the committed blanks (ADR-0006, ADR-0009): fill the real TL 407 and Kug 200b
// with synthetic data, read every value back (`Ł`, `ğ`, `ß` included) from the unflattened fill,
// and check the flattened output. Nothing filled is written to disk.

const font = loadFont();
const tl407 = loadFormVersion("tl407", "08-2025");
const kug200b = loadFormVersion("kug200b", "09-2021");
const today = "2091-03-01";
let measure: TextMeasure;
beforeAll(async () => {
  measure = await createTextMeasure(font);
});

/** What each AcroForm field must read after filling: the filled value, else null. */
function expected(map: FieldMap, fields: readonly FilledField[], all: Iterable<string>) {
  const onStates = new Map<string, string>();
  for (const entry of map.entries) {
    for (const column of entry.kind === "table" ? entry.columns : [entry]) {
      if (column.kind === "checkbox")
        for (const name of column.fields) onStates.set(name, column.onState);
    }
  }
  const values: Record<string, string | null> = Object.fromEntries(
    [...all].map((name) => [name, null]),
  );
  for (const field of fields) {
    values[field.name] = field.kind === "checkbox" ? onStates.get(field.name)! : field.value;
  }
  return values;
}

const neverFilledValues = (map: FieldMap, values: Record<string, string | null>) =>
  Object.fromEntries(map.neverFilled.map(({ field }) => [field, values[field]]));
const nulls = (map: FieldMap) =>
  Object.fromEntries(map.neverFilled.map(({ field }) => [field, null]));

/** References to objects that don't exist (strict readers report a broken cross-reference). */
async function danglingReferences(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  let count = 0;
  const visit = (value: unknown): void => {
    if (value instanceof PDFRef) count += doc.context.lookup(value) ? 0 : 1;
    else if (value instanceof PDFDict) for (const [, entry] of value.entries()) visit(entry);
    else if (value instanceof PDFArray) for (const entry of value.asArray()) visit(entry);
    else if (value instanceof PDFStream) visit(value.dict);
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
  return count;
}

async function fillTl407(input: FormInput) {
  const validation = validateFormInput(input, tl407.fieldMap, today);
  const layout = layoutTl407(input, tl407.fieldMap, measure);
  const fill = (flatten: boolean) =>
    fillAcroForm(font, {
      template: tl407.blank,
      fieldMap: tl407.fieldMap,
      fields: layout.fields,
      flatten,
    });
  return { validation, layout, unflattened: await fill(false), flattened: await fill(true) };
}

describe("PdfRenderer contract: TL 407 08/2025", () => {
  it("fills every value and reads it back, Ł, ğ, ş and ß included; flattened it keeps 7 pages", async () => {
    const { validation, layout, unflattened, flattened } = await fillTl407(
      tl407Input(syntheticTl407),
    );
    expect(validation).toEqual({ errors: [], warnings: [], blanks: [] });
    const values = await readAcroFormValues(unflattened);
    expect(values).toEqual(expected(tl407.fieldMap, layout.fields, Object.keys(values)));
    expect(values).toMatchObject({
      txtfPersonVorname: "Łucja Ayşe",
      txtfPersonNachname: "Doğan-Großmann",
      txtfProfilPersonNachname: "Doğan-Großmann",
      txtfPersonStr: "Weißdornweg",
      datePersonGebDatum: "29.07.2051",
      chbxParagraph111: "Nach Paragraph 111 SGBIII",
      chbxParagraph110: null,
      dateVerweilDauerVon: "01.04.2091",
      txtfPersonRvNr: "12290751D123",
      rbtnPersonGeschlecht: "weiblich",
      rbtnLeistungBedarfZ1: "Kein Handlungsbedarf",
    });
    expect(neverFilledValues(tl407.fieldMap, values)).toEqual(nulls(tl407.fieldMap));
    expect(await pageCount(flattened)).toBe(7);
    expect(Object.keys(await readAcroFormValues(flattened))).toEqual([]);
    expect(await danglingReferences(flattened)).toBe(0);
  });

  it("leaves the beE stay blank in ta_only and ticks §110 (Q181)", async () => {
    const input = tl407Input({
      ...syntheticTl407,
      projectType: "ta_only",
      tgStart: null,
      tgEnd: null,
    });
    const { validation, unflattened } = await fillTl407(input);
    expect(validation.errors).toEqual([]);
    expect(await readAcroFormValues(unflattened)).toMatchObject({
      chbxParagraph110: "Nach Paragraph 110 SGBIII",
      chbxParagraph111: null,
      dateVerweilDauerVon: null,
      dateVerweilDauerBis: null,
    });
    const tg = validateFormInput(
      tl407Input({ ...syntheticTl407, tgStart: null }),
      tl407.fieldMap,
      today,
    );
    expect(tg.errors).toEqual([{ code: "required_missing", key: "beeFrom" }]);
  });

  it("refuses an RV-Nummer too long for its field, never cutting it (Q180)", () => {
    const input = tl407Input({
      ...syntheticTl407,
      sensitive: { ...syntheticTl407.sensitive, pensionInsuranceNumber: "12290751D1234" },
    });
    expect(validateFormInput(input, tl407.fieldMap, today).errors).toEqual([
      { code: "identifier_too_long", key: "pensionInsuranceNumber" },
    ]);
  });

  it("moves overflowing jobs and a long text to the Anlage and prints them as one packet", async () => {
    const jobs = Array.from({ length: 9 }, (_, index) => {
      const from = addMonths("2088-04-01", 3 * index);
      return {
        from,
        to: addDays(addMonths(from, 3), -1),
        employer: `Beispielbetrieb ${index + 1}, Beispielstadt`,
        activity: "Lagerist",
      };
    });
    const long = Array.from({ length: 120 }, (_, index) => `Schritt${index + 1}`).join(" ");
    const input = tl407Input({
      ...syntheticTl407,
      today: "2091-03-01",
      profile: { ...syntheticTl407.profile, workHistory: jobs },
      assessment: { ...syntheticTl407.assessment!, nextSteps: long },
    });
    const { layout, unflattened, flattened } = await fillTl407(input);
    const values = await readAcroFormValues(unflattened);
    expect(values.txtfBerufStelleZ1).toBe("Beispielbetrieb 9, Beispielstadt");
    expect(values.txtfBerufStelleZ6).toBe("Beispielbetrieb 4, Beispielstadt");
    expect(values.txtfBerufStelleZ7).toBe("weitere siehe Anlage");
    expect(values.dateBerufVonZ7).toBeNull();
    expect(values.txtareaWeiteresVorgehen).toMatch(/^Schritt1 .* … Fortsetzung siehe Anlage$/);
    const sections = layout.anlage!.sections;
    expect(sections.map((section) => section.heading)).toEqual([
      "39 Schulbesuch, Aus- und Weiterbildung, Zeile 1: Schul-/Ausbildung als",
      "40 Beruflicher Werdegang",
      "B. Weiteres Vorgehen",
    ]);
    expect(sections[1]).toMatchObject({
      rows: [
        expect.arrayContaining(["Beispielbetrieb 3, Beispielstadt"]),
        expect.anything(),
        expect.anything(),
      ],
    });
    const shown = values.txtareaWeiteresVorgehen!.replace(" … Fortsetzung siehe Anlage", "");
    expect(`${shown} ${(sections[2] as { text: string }).text}`).toBe(long);

    const anlage = await new MockHtmlRenderer(font).render(
      renderAnlage(loadOwnTemplate(layout.anlage!.template), layout.anlage!),
    );
    const packet = await mergePdfs([flattened, anlage]);
    expect(await pageCount(packet)).toBe(7 + (await pageCount(anlage)));
  });

  it("finds the month-14 birth date of the synthetic fixture copy a hard error", async () => {
    const fixture = readFileSync(
      new URL("../../../../fixtures/forms/tl407-08-2025-synthetic.pdf", import.meta.url),
    );
    const values = await readAcroFormValues(new Uint8Array(fixture));
    const fields: FilledField[] = Object.entries(values)
      .filter(([name, value]) => value !== null && name.startsWith("date"))
      .map(([name, value]) => ({ name, kind: "text", value: value!, fontSize: 9 }));
    expect(checkFilledFields(fields, tl407.fieldMap)).toEqual([
      { code: "date_invalid", key: "datePersonGebDatum" },
      { code: "date_invalid", key: "dateProfilPersonGebDatum" },
    ]);
  });
});

describe("PdfRenderer contract: Kug 200b 09/2021", () => {
  it("fills 1–12, reads them back and never fills 13–19; flattened it keeps 1 page", async () => {
    const input = kug200bInput(syntheticKug200b);
    expect(validateFormInput(input, kug200b.fieldMap, today)).toEqual({
      errors: [],
      warnings: [],
      blanks: [],
    });
    const layout = layoutForm(input, kug200b.fieldMap, measure);
    const fill = (flatten: boolean) =>
      fillAcroForm(font, {
        template: kug200b.blank,
        fieldMap: kug200b.fieldMap,
        fields: layout.fields,
        flatten,
      });
    const values = await readAcroFormValues(await fill(false));
    expect(values).toEqual(expected(kug200b.fieldMap, layout.fields, Object.keys(values)));
    expect(values).toMatchObject({
      "2_txtf_Bezeichnung_Betrieb": "Fußball Bund Beispiel GmbH",
      "3_txtf_Vorname": "Łucja Ayşe",
      "4_txtf_Nachname": "Doğan-Großmann",
      "10_txtf_andere_Staatsangehoerigkeit": "Polen",
      "12_rbtn_Schwerbehinderung_Gleichstellung": "Nein",
    });
    expect(neverFilledValues(kug200b.fieldMap, values)).toEqual(nulls(kug200b.fieldMap));
    const flattened = await fill(true);
    expect(await pageCount(flattened)).toBe(1);
    expect(await danglingReferences(flattened)).toBe(0);
  });

  it("leaves missing data blank for handwriting and lists the blank `*` fields", () => {
    const input = kug200bInput({
      ...syntheticKug200b,
      sensitive: { ...syntheticKug200b.sensitive, pensionInsuranceNumber: null },
    });
    expect(validateFormInput(input, kug200b.fieldMap, today).blanks).toEqual([
      { code: "required_blank", key: "pensionInsuranceNumber" },
    ]);
    const names = layoutForm(input, kug200b.fieldMap, measure).fields.map(({ name }) => name);
    expect(names).not.toContain("11_txtf_Rentenversicherungsnummer");
  });
});

const fillBlankTl407 = (fields: FilledField[]) =>
  fillAcroForm(font, { template: tl407.blank, fieldMap: tl407.fieldMap, fields });

describe("fillAcroForm refusals and choices", () => {
  it("refuses a field the map never fills or a value of the wrong kind", async () => {
    await expect(
      fillBlankTl407([{ name: "txtfVermerkKdNr", kind: "text", value: "x", fontSize: 9 }]),
    ).rejects.toThrow(FormFillRefused);
    await expect(
      fillBlankTl407([{ name: "rbtnPersonGeschlecht", kind: "text", value: "x", fontSize: 9 }]),
    ).rejects.toThrow(FormFillRefused);
  });

  it("sets one on-state of a checkbox with several, and a header on both pages (Kug 200a)", async () => {
    const kug200a = loadFormVersion("kug200a", "07-2025");
    const fill = (value: string, flatten = false) =>
      fillAcroForm(font, {
        template: kug200a.blank,
        fieldMap: kug200a.fieldMap,
        fields: [
          { name: "chbxTNEinverstaendnisZ1", kind: "checkbox_choice", value },
          {
            name: "txtfTGBezeichnung",
            kind: "text",
            value: "Beispiel Transfergesellschaft mbH",
            fontSize: 9,
          },
        ],
        flatten,
      });
    const values = await readAcroFormValues(await fill("liegt nicht vor"));
    expect(values.chbxTNEinverstaendnisZ1).toBe("liegt nicht vor");
    expect(values.txtfTGBezeichnung).toBe("Beispiel Transfergesellschaft mbH");
    const flattened = await fill("ist beigefuegt", true);
    expect(await pageCount(flattened)).toBe(2);
    expect(await danglingReferences(flattened)).toBe(0);
    await expect(fill("vielleicht")).rejects.toThrow(FormFillRefused);
  });
});
