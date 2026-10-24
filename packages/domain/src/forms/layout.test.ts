import { describe, expect, it } from "vitest";
import type { FormInput, FormRow } from "./input";
import {
  checkFilledFields,
  FormLayoutError,
  layoutForm,
  layoutTl407,
  type FilledField,
} from "./layout";
import { testMap, testMeasure } from "./testing/maps";

// testMeasure: 0.5 em per character, 1 em high. Inner widths (box − 4): names 100, notes 60 ×
// 36 (multiline), table notes 60, code 36, RV-Nummer 40; 10 pt default, 8 pt minimum.

const input = (values: FormInput["values"], tables: FormInput["tables"] = {}): FormInput => ({
  formCode: "tl407",
  projectType: "ta_tg",
  values: { firstName: "Łucja", lastName: "Doğan", birthDate: "2051-07-29", ...values },
  tables,
});
const layout = (values: FormInput["values"], tables?: FormInput["tables"]) =>
  layoutForm(input(values, tables), testMap, testMeasure);
const field = (fields: FilledField[], name: string) => fields.find((each) => each.name === name);

describe("layoutForm (ba-forms.md, overflow)", () => {
  it("fills every kind into its AcroForm fields, a repeated name in each", () => {
    const { fields, anlage, notFitting } = layout({
      tg: true,
      beeFrom: "2091-04-01",
      gender: "female",
      attached: "missing",
      start: "09:00",
      scope: "nationwide",
      entryDate: null,
    });
    expect(fields).toEqual([
      { name: "chbxTg", kind: "checkbox" },
      { name: "txtFirst", kind: "text", value: "Łucja", fontSize: 10 },
      { name: "txtFirst2", kind: "text", value: "Łucja", fontSize: 10 },
      { name: "txtLast", kind: "text", value: "Doğan", fontSize: 10 },
      { name: "dateBirth", kind: "text", value: "29.07.2051", fontSize: 10 },
      { name: "dateBeeFrom", kind: "text", value: "01.04.2091", fontSize: 10 },
      { name: "rbtnGender", kind: "radio", value: "w" },
      { name: "chbxAttached", kind: "checkbox_choice", value: "liegt nicht vor" },
      { name: "timeStart", kind: "text", value: "09:00", fontSize: 10 },
      { name: "rbtnScope", kind: "radio", value: "bundesweit" },
    ]);
    expect([anlage, notFitting]).toEqual([null, []]);
  });

  it("skips a field that doesn't apply to the project type", () => {
    const { fields } = layoutForm(
      { ...input({ tg: true, beeFrom: "2091-04-01" }), projectType: "ta_only" },
      testMap,
      testMeasure,
    );
    expect(fields.map(({ name }) => name)).toEqual([
      "txtFirst",
      "txtFirst2",
      "txtLast",
      "dateBirth",
    ]);
  });

  it("shrinks a text to fit, down to the minimum size", () => {
    const { fields } = layout({ lastName: "Doğan-Großmann-Kowalsk" }); // 22 characters
    expect(field(fields, "txtLast")).toMatchObject({ fontSize: 9 });
  });

  it("cuts a text one word too long at a word boundary and continues it on the Anlage", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj"; // 4 lines of 14 at 8 pt
    const { fields, anlage } = layout({ notes: text });
    const shown = field(fields, "txtNotes") as { value: string; fontSize: number };
    expect(shown.fontSize).toBe(8);
    expect(shown.value).toMatch(/^aaaa .* … Fortsetzung siehe Anlage$/);
    const head = shown.value.replace(" … Fortsetzung siehe Anlage", "");
    expect(anlage).toEqual({
      template: "anlage-profilingbogen:v1",
      title: "Anlage zum Profilingbogen (TL 407 08/2025)",
      name: "Łucja Doğan",
      birthDate: "29.07.2051",
      sections: [{ kind: "text", heading: "B. Weiteres Vorgehen", text: expect.any(String) }],
    });
    expect(`${head} ${anlage!.sections[0]!.kind === "text" && anlage!.sections[0]!.text}`).toBe(
      text,
    );
    const fitting = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii"; // 3 lines at 8 pt
    expect(layout({ notes: fitting }).anlage).toBeNull();
  });

  it("breaks lines at line breaks and keeps a word wider than the box whole", () => {
    expect(field(layout({ notes: "eins\n\nzwei" }).fields, "txtNotes")).toMatchObject({
      fontSize: 10,
    });
    const fourLines = layout({ notes: "eins\nzwei\ndrei\nvier" });
    expect(field(fourLines.fields, "txtNotes")).toMatchObject({
      fontSize: 8,
      value: expect.stringMatching(/Fortsetzung/),
    });
    const wide = layout({ notes: "Donaudampfschifffahrtsgesellschaft" });
    expect(field(wide.fields, "txtNotes")).toMatchObject({ value: "Fortsetzung siehe Anlage" });
    const spaced = layout({ notes: "eins zwei drei vier fünf sechs  \nsieben" });
    expect(field(spaced.fields, "txtNotes")).toMatchObject({ fontSize: 8 });
  });

  it("takes the shorter note where the longer doesn't fit, and the note alone where no word fits", () => {
    const { fields, anlage } = layout({ code: "Fachkraft Lager" });
    expect(field(fields, "txtCode")).toMatchObject({ value: "siehe Anlage", fontSize: 8 });
    expect(anlage!.sections).toEqual([
      { kind: "text", heading: "Kürzel", text: "Fachkraft Lager" },
    ]);
    const long = layout({ lastName: "Aaaaaaaaaaaaaaaaaaaaaaaaa Bbbbbbbbbbbbbbbbbbbbbb" });
    expect(field(long.fields, "txtLast")).toMatchObject({ value: "Fortsetzung siehe Anlage" });
  });

  it("falls back to the shortest note when even it doesn't fit", () => {
    const tiny = {
      ...testMap,
      entries: testMap.entries.map((entry) =>
        entry.key === "code" && entry.kind === "text"
          ? { ...entry, box: { width: 20, height: 14 } }
          : entry,
      ),
    };
    const { fields, anlage } = layoutForm(input({ code: "Fachkraft" }), tiny, testMeasure);
    expect(field(fields, "txtCode")).toMatchObject({ value: "siehe Anlage" });
    expect(anlage!.sections).toEqual([{ kind: "text", heading: "Kürzel", text: "Fachkraft" }]);
  });

  it("shrinks an identifier below the minimum rather than cutting it (Q180)", () => {
    const { fields, anlage } = layout({ rvNumber: "12290751D123" });
    expect(field(fields, "txtRv")).toEqual({
      name: "txtRv",
      kind: "text",
      value: "12290751D123",
      fontSize: 6.6,
    });
    expect(anlage).toBeNull();
  });

  it("leaves a text that doesn't fit blank on a form without an Anlage", () => {
    const noAnlage = { ...testMap, anlage: null };
    const result = layoutForm(input({ code: "Fachkraft Lager" }), noAnlage, testMeasure);
    expect(field(result.fields, "txtCode")).toBeUndefined();
    expect(result.notFitting).toEqual([{ code: "text_not_fitting", key: "code" }]);
    expect(result.anlage).toBeNull();
  });

  it("moves the last form row and every later row to the Anlage, marking the row", () => {
    const sessions: FormRow[] = [
      {
        date: "2091-02-20",
        from: "09:00",
        to: "10:00",
        note: "Erstgespräch",
        done: true,
        level: "basic",
      },
      { date: "2091-02-21", from: "09:00", to: "10:00", note: "Fachkraft Lagerlogistik" },
      { date: "2091-02-22", from: "10:00", to: "11:00", note: null, done: true, level: "basic" },
      { date: "2091-02-23", from: "11:00", to: "12:00" },
    ];
    const { fields, anlage } = layout({}, { sessions });
    expect(
      fields.filter(({ name }) => /[123]$/.test(name) && !name.startsWith("txtFirst")),
    ).toEqual([
      { name: "dateS1", kind: "text", value: "20.02.2091", fontSize: 10 },
      { name: "timeF1", kind: "text", value: "09:00", fontSize: 10 },
      { name: "timeT1", kind: "text", value: "10:00", fontSize: 10 },
      { name: "txtN1", kind: "text", value: "Erstgespräch", fontSize: 10 },
      { name: "chbxD1", kind: "checkbox" },
      { name: "rbtnL1", kind: "radio", value: "Grund" },
      { name: "dateS2", kind: "text", value: "21.02.2091", fontSize: 10 },
      { name: "timeF2", kind: "text", value: "09:00", fontSize: 10 },
      { name: "timeT2", kind: "text", value: "10:00", fontSize: 10 },
      { name: "txtN2", kind: "text", value: "siehe Anlage", fontSize: 8 },
      { name: "dateS3", kind: "text", value: "weitere siehe Anlage", fontSize: 8, marker: true },
    ]);
    expect(anlage!.sections).toEqual([
      { kind: "text", heading: "11 Termine, Zeile 2: Notiz", text: "Fachkraft Lagerlogistik" },
      {
        kind: "table",
        heading: "11 Termine",
        columns: ["Am", "Von", "Bis", "Notiz", "Erledigt", "Stufe"],
        rows: [
          ["22.02.2091", "10:00", "11:00", "", "Ja", "Grund"],
          ["23.02.2091", "11:00", "12:00", "", "", ""],
        ],
      },
    ]);
  });

  it("refuses more rows than the form holds without a marker or an Anlage", () => {
    const work = [{ from: "2090-01-01" }, { from: "2089-01-01" }, { from: "2088-01-01" }];
    expect(() => layout({}, { work })).toThrow(RangeError);
    const sessions = [1, 2, 3, 4].map((day) => ({ date: `2091-02-0${day}` }));
    expect(() =>
      layoutForm(input({}, { sessions }), { ...testMap, anlage: null }, testMeasure),
    ).toThrow(RangeError);
    expect(layout({}, { work: work.slice(0, 2) }).fields.map(({ name }) => name)).toContain(
      "dateW2",
    );
  });

  it("names the person without a birth date when it is missing", () => {
    const { anlage } = layout({ birthDate: null, code: "Fachkraft Lager" });
    expect(anlage).toMatchObject({ name: "Łucja Doğan", birthDate: "" });
  });

  it("checks its output again and fails on a value the input check would refuse", () => {
    const thrown = (() => {
      try {
        return layout({ start: "25:00" });
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(FormLayoutError);
    expect((thrown as FormLayoutError).issues).toEqual([
      { code: "time_invalid", key: "timeStart" },
    ]);
  });

  it("refuses an input or a map of another form", () => {
    expect(() => layoutForm({ ...input({}), formCode: "kug200b" }, testMap, testMeasure)).toThrow(
      RangeError,
    );
    expect(() => layoutTl407(input({}), { ...testMap, formCode: "kug200b" }, testMeasure)).toThrow(
      RangeError,
    );
    expect(layoutTl407(input({}), testMap, testMeasure).fields).toHaveLength(4);
  });
});

describe("checkFilledFields (ba-forms.md, validation before rendering)", () => {
  it("refuses the month-14 date, a bad time and a field the map never fills", () => {
    expect(
      checkFilledFields(
        [
          { name: "dateBirth", kind: "text", value: "03.14.1998", fontSize: 9 },
          { name: "dateBeeFrom", kind: "text", value: "29.02.2092", fontSize: 9 },
          { name: "timeStart", kind: "text", value: "9:00", fontSize: 9 },
          { name: "txtSignature", kind: "text", value: "Berlin", fontSize: 9 },
          {
            name: "dateS3",
            kind: "text",
            value: "weitere siehe Anlage",
            fontSize: 8,
            marker: true,
          },
          { name: "rbtnGender", kind: "radio", value: "w" },
          { name: "txtFirst", kind: "text", value: "x", fontSize: 9 },
        ],
        testMap,
      ),
    ).toEqual([
      { code: "date_invalid", key: "dateBirth" },
      { code: "time_invalid", key: "timeStart" },
      { code: "field_not_fillable", key: "txtSignature" },
    ]);
  });
});
