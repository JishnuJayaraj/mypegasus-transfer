import { describe, expect, it } from "vitest";
import { FieldMap } from "../forms/field-map";
import { testMeasure } from "../forms/testing";
import {
  checkKug200a,
  kug200aList,
  kug200aRowsPerCopy,
  type Kug200aMemberSource,
  type Kug200aSource,
} from "./kug200a";

// The Kug 200a of a batch (ba-forms.md, the Kug 200a as built; Q197, Q205). Synthetic names,
// addresses and RV-Nummern only. The map has the real one's keys, field names and boxes.

const rows = (prefix: string) =>
  Array.from({ length: kug200aRowsPerCopy }, (_, i) => `${prefix}Z${i + 1}`);
const text = (key: string, width: number, height: number, multiline: boolean) => ({
  key,
  width,
  height,
  multiline,
});
const header = [
  ["tgName", "txtfTGBezeichnung", "Bezeichnung der Transfergesellschaft", 243],
  ["tgBetriebsnummer", "txtfTGBetriebNr", "Betriebsnummer der Transfergesellschaft", 117],
  ["tgKugNumber", "txtfTGKugNr", "T-Kug-Nummer", 127],
  ["tgEconomicClass", "txtfTGWK", "Branche/Wirtschaftsklasse der Transfergesellschaft", 216],
  ["employerName", "txtfPABBezeichnung", "Bezeichnung des personalabgebenden Betriebes", 243],
  [
    "employerBetriebsnummer",
    "txtfPABetriebNr",
    "Betriebsnummer des personalabgebenden Betriebes",
    117,
  ],
  ["employerEconomicClass", "txtfPABWK", "Branche/WK des personalabgebenden Betriebes", 216],
] as const;
const columns = [
  text("personalData", 120, 60, true),
  text("insuranceNumber", 75, 18, false),
  text("lastActivity", 81, 60, true),
  text("lastActivityPeriod", 81, 60, true),
  text("plannedTgPeriod", 87, 60, true),
];
const map = FieldMap.parse({
  formCode: "kug200a",
  version: "07-2025",
  label: "Kug 200a 07/2025",
  fontSize: 8,
  minFontSize: 6,
  missingRequired: "blank",
  anlage: null,
  entries: [
    ...header.map(([key, field, label, width]) => ({
      key,
      label,
      kind: "text",
      fields: [field],
      required: false,
      box: { width, height: 18 },
      multiline: false,
      fontSize: 9,
    })),
    {
      key: "infoEventDate",
      label: "Teilnahme an der Info-Veranstaltung, Datum am",
      kind: "date",
      fields: ["dateTNVeranstaltung"],
      required: false,
    },
    {
      kind: "table",
      key: "participants",
      label: "Liste der Teilnehmenden",
      required: false,
      rows: kug200aRowsPerCopy,
      columns: [
        ...columns.map(({ key, width, height, multiline }) => ({
          key,
          label: key,
          kind: "text",
          fields: rows(`col_${key}`),
          box: { width, height },
          multiline,
          ...(key === "insuranceNumber" && { identifier: { maxLength: 12 } }),
        })),
        {
          key: "declarationAttached",
          label: "Erklärung beigefügt",
          kind: "checkbox",
          fields: rows("chbxErklaerung"),
          onState: "selektiert",
        },
        {
          key: "consentDeclaration",
          label: "Einverständniserklärung",
          kind: "checkbox_choice",
          fields: rows("chbxEinverstaendnis"),
          options: { attached: "ist beigefuegt", not_available: "liegt nicht vor" },
        },
        {
          key: "infoEventAttended",
          label: "Teilnahme an der Info-Veranstaltung",
          kind: "checkbox",
          fields: rows("chbxTeilnahme"),
          onState: "selektiert",
        },
      ],
      dateRanges: [],
      timeRanges: [],
    },
  ],
  dateRanges: [],
  neverFilled: [],
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const member = (n: number, overrides: Partial<Kug200aMemberSource> = {}): Kug200aMemberSource => ({
  participationId: id(n),
  identity: { firstName: "Erika", lastName: `Muster${n}` },
  address: { street: "Beispielweg 1", postalCode: "10115", city: "Berlin", country: "DE" },
  insuranceNumber: "65170839J003",
  tgStart: "2027-01-01",
  tgEnd: "2027-12-31",
  declaration17: "in_packet",
  infoEventDates: ["2026-11-20"],
  ...overrides,
});

const source = (
  members: Kug200aMemberSource[],
  overrides: Partial<Kug200aSource["header"]> = {},
): Kug200aSource => ({
  header: {
    transferCompany: {
      name: "Beispiel Transfergesellschaft mbH",
      betriebsnummer: "12345678",
      economicClass: "N 78.30",
    },
    tKugNumber: "0001-2026",
    employer: { name: "Muster Metall GmbH", betriebsnummer: "87654321", economicClass: "C 25.62" },
    ...overrides,
  },
  members,
});

const check = (s: Kug200aSource) => checkKug200a(s, map, "2026-11-24", testMeasure);
const value = (fields: { name: string }[], name: string) =>
  fields.find((field) => field.name === name) as { value?: string } | undefined;

describe("checkKug200a", () => {
  it("fills the header and one row of a one-member batch", () => {
    const { copies, checklist } = check(source([member(1)]));
    expect(copies).toHaveLength(1);
    const fields = copies[0]!;
    expect(value(fields, "txtfTGBezeichnung")?.value).toBe("Beispiel Transfergesellschaft mbH");
    expect(value(fields, "txtfTGKugNr")?.value).toBe("0001-2026");
    expect(value(fields, "txtfPABetriebNr")?.value).toBe("87654321");
    expect(value(fields, "dateTNVeranstaltung")?.value).toBe("20.11.2026");
    expect(value(fields, "col_personalDataZ1")?.value).toBe(
      "Muster1, Erika\nBeispielweg 1\n10115 Berlin",
    );
    expect(value(fields, "col_insuranceNumberZ1")?.value).toBe("65170839J003");
    expect(value(fields, "col_plannedTgPeriodZ1")?.value).toBe("01.01.2027 – 31.12.2027");
    expect(fields).toContainEqual({ name: "chbxErklaerungZ1", kind: "checkbox" });
    expect(fields).toContainEqual({
      name: "chbxEinverstaendnisZ1",
      kind: "checkbox_choice",
      value: "ist beigefuegt",
    });
    expect(fields).toContainEqual({ name: "chbxTeilnahmeZ1", kind: "checkbox" });
    expect(value(fields, "col_lastActivityZ1")).toBeUndefined();
    expect(fields.some((field) => field.name.endsWith("Z2"))).toBe(false);
    // The last activity and its period are the data's to decide, never guessed (Q205).
    expect(checklist).toEqual([
      {
        code: "not_decided",
        key: "participants.lastActivity",
        label: "Liste der Teilnehmenden: lastActivity",
        participationIds: [id(1)],
      },
      {
        code: "not_decided",
        key: "participants.lastActivityPeriod",
        label: "Liste der Teilnehmenden: lastActivityPeriod",
        participationIds: [id(1)],
      },
    ]);
  });

  it("spans copies of six, the header on every copy, the rows in order", () => {
    const members = Array.from({ length: 13 }, (_, i) => member(i + 1));
    const { copies, checklist } = check(source(members));
    expect(copies).toHaveLength(3);
    for (const fields of copies) {
      expect(value(fields, "txtfTGBezeichnung")?.value).toBe("Beispiel Transfergesellschaft mbH");
      expect(value(fields, "dateTNVeranstaltung")?.value).toBe("20.11.2026");
    }
    expect(value(copies[1]!, "col_personalDataZ1")?.value).toMatch(/^Muster7, /);
    expect(value(copies[1]!, "col_personalDataZ6")?.value).toMatch(/^Muster12, /);
    expect(value(copies[2]!, "col_personalDataZ1")?.value).toMatch(/^Muster13, /);
    expect(copies[2]!.some((field) => field.name.endsWith("Z2"))).toBe(false);
    expect(checklist[0]!.participationIds).toEqual(members.map((m) => m.participationId));
  });

  it("lists every header key and member value the platform doesn't hold", () => {
    const { copies, checklist } = check(
      source(
        [
          member(1, { address: null }),
          member(2, { insuranceNumber: null }),
          member(3, { tgEnd: null }),
        ],
        {
          transferCompany: { name: "Beispiel Transfergesellschaft mbH" },
          tKugNumber: null,
          employer: { name: "Muster Metall GmbH", betriebsnummer: null, economicClass: "" },
        },
      ),
    );
    expect(value(copies[0]!, "col_personalDataZ1")?.value).toBe("Muster1, Erika");
    expect(value(copies[0]!, "txtfTGBetriebNr")).toBeUndefined();
    expect(
      checklist
        .filter((item) => item.code === "not_recorded")
        .map(({ key, participationIds }) => [key, participationIds]),
    ).toEqual([
      ["tgBetriebsnummer", []],
      ["tgKugNumber", []],
      ["tgEconomicClass", []],
      ["employerBetriebsnummer", []],
      ["employerEconomicClass", []],
      ["participants.personalData", [id(1)]],
      ["participants.insuranceNumber", [id(2)]],
      ["participants.plannedTgPeriod", [id(3)]],
    ]);
  });

  it("prints the info event's date only when the batch's attendances share it", () => {
    const several = check(
      source([
        member(1),
        member(2, { infoEventDates: ["2026-11-21"] }),
        member(3, { infoEventDates: [] }),
      ]),
    );
    const fields = several.copies[0]!;
    expect(value(fields, "dateTNVeranstaltung")).toBeUndefined();
    expect(fields.filter((f) => f.name.startsWith("chbxTeilnahme")).map((f) => f.name)).toEqual([
      "chbxTeilnahmeZ1",
      "chbxTeilnahmeZ2",
    ]);
    expect(several.checklist[0]).toEqual({
      code: "not_decided",
      key: "infoEventDate",
      label: "Teilnahme an der Info-Veranstaltung, Datum am",
      participationIds: [],
    });

    const one = check(
      source([member(1), member(2, { infoEventDates: ["2026-11-20", "2026-11-20"] })]),
    );
    expect(value(one.copies[0]!, "dateTNVeranstaltung")?.value).toBe("20.11.2026");
    expect(one.checklist.map((item) => item.key)).not.toContain("infoEventDate");

    // No info event at all: nothing to tick and nothing to write.
    const none = check(source([member(1, { infoEventDates: [] })]));
    expect(none.copies[0]!.some((f) => f.name.startsWith("chbxTeilnahme"))).toBe(false);
    expect(value(none.copies[0]!, "dateTNVeranstaltung")).toBeUndefined();
    expect(none.checklist.map((item) => item.key)).not.toContain("infoEventDate");
  });

  it("marks the consent as the packet carries it, else leaves it to decide (Q205 (4))", () => {
    const { copies, checklist } = check(
      source([member(1), member(2, { declaration17: "other_paper" })]),
    );
    expect(copies[0]).toContainEqual({
      name: "chbxEinverstaendnisZ1",
      kind: "checkbox_choice",
      value: "ist beigefuegt",
    });
    expect(copies[0]!.some((field) => field.name === "chbxEinverstaendnisZ2")).toBe(false);
    expect(checklist).toContainEqual({
      code: "not_in_packet",
      key: "participants.consentDeclaration",
      label: "Liste der Teilnehmenden: Einverständniserklärung",
      participationIds: [id(2)],
    });
    // The alternative list leaves the same box empty and lists it.
    const list = kug200aList(source([member(1, { declaration17: "other_paper" })]), map, template, {
      createdOn: "2026-11-24",
    });
    expect((list.document.text.blocks[1] as { rows: string[][] }).rows[0]![7]).toBe("");
    expect(list.checklist.map((item) => item.code)).toContain("not_in_packet");
  });

  it("marks the consent 'liegt nicht vor' without declaration 17 in force", () => {
    const { copies } = check(source([member(1, { declaration17: "none" })]));
    expect(copies[0]).toContainEqual({
      name: "chbxEinverstaendnisZ1",
      kind: "checkbox_choice",
      value: "liegt nicht vor",
    });
  });

  it("leaves a value the form can't take blank and lists it, never the whole list refused", () => {
    const { copies, checklist } = check(
      source(
        [
          member(1, { identity: { firstName: "Ana", lastName: "Muster一" } }),
          member(2, { insuranceNumber: "65170839J0031" }),
          member(3, { identity: { firstName: "Łucja", lastName: "Yılmaz-Groß" } }),
        ],
        { tKugNumber: "0001-一" },
      ),
    );
    const fields = copies[0]!;
    expect(value(fields, "col_personalDataZ1")).toBeUndefined();
    expect(value(fields, "col_insuranceNumberZ2")).toBeUndefined();
    expect(value(fields, "txtfTGKugNr")).toBeUndefined();
    expect(value(fields, "col_personalDataZ3")?.value).toMatch(/^Yılmaz-Groß, Łucja/);
    expect(
      checklist
        .filter((item) => item.code !== "not_decided")
        .map(({ code, key, participationIds }) => [code, key, participationIds]),
    ).toEqual([
      ["character_unsupported", "tgKugNumber", []],
      ["character_unsupported", "participants.personalData", [id(1)]],
      ["identifier_too_long", "participants.insuranceNumber", [id(2)]],
    ]);
  });

  it("shrinks a long address to the floor and beyond it leaves the box blank, listed by member", () => {
    const long = "Sehr lange Straße mit einem außergewöhnlich ausführlichen Namen 123";
    const { copies, checklist } = check(
      source([
        member(1),
        member(2, {
          address: {
            street: `${long} ${long} ${long}`,
            postalCode: "10115",
            city: "Berlin",
            country: "DE",
          },
        }),
      ]),
    );
    expect(value(copies[0]!, "col_personalDataZ2")).toBeUndefined();
    expect(checklist).toContainEqual({
      code: "text_not_fitting",
      key: "participants.personalData",
      label: "Liste der Teilnehmenden: personalData",
      participationIds: [id(2)],
    });
  });

  it("groups a key's members, and lists a header text too long for its box", () => {
    const unsupported = { firstName: "Ana", lastName: "Muster\u4e00" };
    const { checklist } = check(
      source(
        [
          member(1, { identity: unsupported }),
          member(2),
          member(3, { identity: unsupported }),
          member(4, { identity: { firstName: null, lastName: null }, address: null }),
        ],
        {
          employer: {
            name: "Muster Metall- und Maschinenbau Gesellschaft mit beschränkter Haftung & Co. Kommanditgesellschaft",
            betriebsnummer: "87654321",
            economicClass: "C 25.62",
          },
        },
      ),
    );
    expect(checklist).toContainEqual(
      expect.objectContaining({
        code: "character_unsupported",
        key: "participants.personalData",
        participationIds: [id(1), id(3)],
      }),
    );
    expect(checklist).toContainEqual(
      expect.objectContaining({
        code: "not_recorded",
        key: "participants.personalData",
        participationIds: [id(4)],
      }),
    );
    expect(checklist).toContainEqual(
      expect.objectContaining({
        code: "text_not_fitting",
        key: "employerName",
        participationIds: [],
      }),
    );
  });

  it("treats any other input error as a defect of its sources", () => {
    expect(() => check(source([member(1, { infoEventDates: ["2026-02-30"] })]))).toThrow(
      /date_invalid/,
    );
  });

  it("refuses another map, a map without six rows and an empty batch", () => {
    expect(() => check(source([]))).toThrow(RangeError);
    expect(() =>
      checkKug200a(source([member(1)]), { ...map, formCode: "kug200b" }, "2026-11-24", testMeasure),
    ).toThrow(RangeError);
    const table = map.entries.at(-1)!;
    const fiveRows = { ...map, entries: [...map.entries.slice(0, -1), { ...table, rows: 5 }] };
    expect(() =>
      checkKug200a(source([member(1)]), fiveRows as FieldMap, "2026-11-24", testMeasure),
    ).toThrow(RangeError);
  });
});

const template = {
  index: "<h1>{{title}}</h1><p>{{subtitle}}</p>{{header}}{{list}}",
  header: "<p>{{title}} {{subtitle}}</p>",
  footer: "<p>Seite</p>",
};

describe("kug200aList", () => {
  it("holds the Kug 200a's contents in one numbered table, every value escaped", () => {
    const { document, checklist } = kug200aList(
      source(
        [member(1, { identity: { firstName: "<b>Ida</b>", lastName: "Muster" } }), member(2)],
        {
          tKugNumber: null,
        },
      ),
      map,
      template,
      { createdOn: "2026-11-24" },
    );
    expect(document.html).toContain("&lt;b&gt;Ida&lt;/b&gt;");
    expect(document.html).not.toContain("<b>Ida");
    expect(document.headerHtml).toContain("Sammelmeldung Kug 200b vom 24.11.2026, 2 Teilnehmende");
    expect(document.text.pageHeader).toEqual([
      "Liste der Teilnehmenden an einer Transfergesellschaft",
      "Sammelmeldung Kug 200b vom 24.11.2026, 2 Teilnehmende",
    ]);
    const [head, list] = document.text.blocks as { rows: string[][] }[];
    expect(head!.rows).toContainEqual(["T-Kug-Nummer", ""]);
    expect(head!.rows).toContainEqual([
      "Teilnahme an der Info-Veranstaltung, Datum am",
      "20.11.2026",
    ]);
    expect(list!.rows[1]).toEqual([
      "2",
      "Muster2, Erika\nBeispielweg 1\n10115 Berlin",
      "65170839J003",
      "",
      "",
      "01.01.2027 – 31.12.2027",
      "Ja",
      "ist beigefuegt",
      "Ja",
    ]);
    expect(checklist.map((item) => [item.code, item.key])).toEqual([
      ["not_recorded", "tgKugNumber"],
      ["not_decided", "participants.lastActivity"],
      ["not_decided", "participants.lastActivityPeriod"],
    ]);
  });

  it("names one participant in the singular and leaves unticked boxes empty", () => {
    const { document } = kug200aList(
      source([member(1, { infoEventDates: [], declaration17: "none" })]),
      map,
      template,
      { createdOn: "2026-11-24" },
    );
    expect(document.text.pageHeader[1]).toBe(
      "Sammelmeldung Kug 200b vom 24.11.2026, 1 Teilnehmende/r",
    );
    const list = document.text.blocks[1] as { rows: string[][] };
    expect(list.rows[0]!.slice(-2)).toEqual(["liegt nicht vor", ""]);
    expect(() => kug200aList(source([]), map, template, { createdOn: "2026-11-24" })).toThrow(
      RangeError,
    );
  });
});
