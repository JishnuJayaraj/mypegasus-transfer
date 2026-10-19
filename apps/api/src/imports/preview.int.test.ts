import { describe, expect, it } from "vitest";
import {
  app,
  werkNord,
  verwaltung,
  fixture,
  rowsOf,
  b64,
  preview,
  previewOf,
  suggested,
  counts,
  codes,
  waveOf,
} from "./import-testing";
import { buildZip } from "./zip-builder";
import { expectProblem } from "../testing";

// Slice 2 plan 5.11 (PR 2g-1): the import preview and the limits (AC-23, AC-26, AC-28, AC-31).

describe("the preview (AC-26, AC-23, AC-31)", () => {
  it("answers sheets, headers and the suggested mapping, and writes nothing", async () => {
    const before = await counts();
    const shown = await previewOf(werkNord, { file: fixture("teilnehmer-beispiel.xlsx") });
    expect(await counts()).toEqual(before);
    expect(shown).toMatchObject({
      format: "xlsx",
      sheets: ["Teilnehmende"],
      sheet: "Teilnehmende",
      csv: null,
      headerRow: 1,
      mapping: [],
      report: null,
      previewToken: null,
    });
    expect(shown.headers).toHaveLength(12);
    // Every header is a built-in synonym, so every column is suggested, none by saved mappings.
    expect(shown.suggestedMapping).toHaveLength(12);
    expect(new Set(shown.suggestedMapping.map((s) => s.source))).toEqual(new Set(["builtin"]));
    expect(shown.missingTargets).toEqual([]);
  });

  it("names the encoding and the delimiter it detected", async () => {
    const shown = await previewOf(werkNord, { file: fixture("teilnehmer-cp1252.csv") });
    expect(shown.csv).toEqual({ delimiter: ";", encoding: "windows-1252" });
    expect(shown.headers[5]).toBe("Straße");
  });

  it("reports the required targets a mapping lacks, and writes no report", async () => {
    const mapping = [
      { column: 0, target: "personnelNumber" },
      { column: 1, target: "lastName" },
    ];
    const shown = await previewOf(werkNord, { file: fixture("teilnehmer-beispiel.csv"), mapping });
    expect(shown.missingTargets.toSorted()).toEqual(
      ["address", "birthDate", "firstName", "oldEmploymentEndDate"].toSorted(),
    );
    expect(shown.report).toBeNull();
    expect(shown.previewToken).toBeNull();
    expect(shown.mappingIssues.every((i) => i.row === null && i.severity === "error")).toBe(true);
  });

  it("makes a report with counts, and a token only for a file without errors", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    expect(shown.report?.counts).toMatchObject({ rows: 12, create: 12, error: 0, warnings: 0 });
    expect(shown.report?.rows).toEqual([]);
    expect(shown.previewToken).toMatch(/^[0-9a-f]{64}$/);
    const faulty = fixture("teilnehmer-fehler.csv");
    const bad = await previewOf(werkNord, {
      file: faulty,
      mapping: await suggested(werkNord, { file: faulty }),
    });
    expect(bad.report?.counts.error).toBeGreaterThan(8);
    expect(bad.previewToken).toBeNull();
  });

  it("takes the header row the PL chooses among the first rows, numbering rows as in the file", async () => {
    const file = fixture("teilnehmer-gemischt.xlsx");
    const extra = { file, sheet: "Teilnehmende", headerRow: 3 };
    const mapping = await suggested(werkNord, extra);
    const shown = await previewOf(werkNord, { ...extra, mapping });
    expect(shown.headerRow).toBe(3);
    expect(shown.headers[0]).toBe("Personalnummer");
    const rows = shown.report!.rows.map((r) => [
      r.row,
      r.outcome,
      r.issues.map((i) => `${i.target}:${i.code}`),
    ]);
    // AC-46: a numeric Personalnummer is an error, a five-digit postcode converts with a warning,
    // a short numeric postcode is an error and a numeric phone is dropped with a warning; a date
    // cell with a time is an error. Rows are numbered as in the file (the header is row 3).
    expect(rows).toEqual([
      [5, "error", ["personnelNumber:identifier_cell_numeric"]],
      [6, "create", ["addressPostalCode:identifier_cell_converted"]],
      [7, "error", ["addressPostalCode:identifier_cell_numeric", "phone:identifier_cell_numeric"]],
      [8, "error", ["birthDate:date_has_time"]],
    ]);
  });

  it("refuses a column the file doesn't have, an unknown sheet and a header row beyond the data", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    expect(
      await codes(await preview(werkNord, { file, mapping: [{ column: 20, target: "phone" }] })),
    ).toEqual(["mapping_column_unknown"]);
    expect(await codes(await preview(werkNord, { file, headerRow: 20 }))).toEqual([
      "header_row_invalid",
    ]);
    expect(
      await codes(
        await preview(werkNord, { file: fixture("teilnehmer-gemischt.xlsx"), sheet: "x" }),
      ),
    ).toEqual(["sheet_not_found"]);
  });

  it("refuses a wave outside the project and any wave in a ta_only project", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    const tagesWave = await waveOf(werkNord);
    expect(await codes(await preview(werkNord, { file, waveId: crypto.randomUUID() }))).toEqual([
      "wave_of_other_project",
    ]);
    expect(await codes(await preview(verwaltung, { file, waveId: tagesWave }))).toEqual([
      "not_ta_tg",
    ]);
  });
});

describe("who may preview (AC-30)", () => {
  it("lets only the project's PL in; a project the user can't see is a 404", async () => {
    const body = { file: fixture("teilnehmer-beispiel.csv") };
    for (const user of ["consultant", "backOffice", "admin", "regionalOperationsManager"]) {
      expect((await preview(werkNord, body, user)).status).toBe(403);
    }
    expect((await preview(crypto.randomUUID(), body)).status).toBe(404);
    expect((await preview(werkNord, body)).status).toBe(200);
  });
});

describe("limits and hostile files (AC-28)", () => {
  it("answers 413 above the body limit and keeps serving", async () => {
    const six = Buffer.alloc(6 * 1024 * 1024, 65).toString("base64");
    const res = await preview(werkNord, { file: six });
    await expectProblem(res, 413, "payload-too-large");
    expect((await app.request("/api/v1/health/ready")).status).toBe(200);
  });

  it("refuses more than 5 MB decoded", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 3, 65).toString("base64");
    expect(await codes(await preview(werkNord, { file: big }))).toEqual(["file_too_large"]);
  });

  it("refuses 5,001 data rows, 51 columns and a 501-character cell", async () => {
    expect(await codes(await preview(werkNord, { file: b64(rowsOf(5001).join("\n")) }))).toEqual([
      "too_many_rows",
    ]);
    expect((await preview(werkNord, { file: b64(rowsOf(5000).join("\n")) })).status).toBe(200);
    expect(
      await codes(
        await preview(werkNord, {
          file: b64(Array.from({ length: 51 }, (_, i) => `c${i}`).join(";")),
        }),
      ),
    ).toEqual(["too_many_columns"]);
    expect(await codes(await preview(werkNord, { file: b64(`Name\n${"x".repeat(501)}`) }))).toEqual(
      ["cell_too_long"],
    );
  });

  it("refuses a file that isn't a spreadsheet", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(await codes(await preview(werkNord, { file: png.toString("base64") }))).toEqual([
      "unsupported_file",
    ]);
  });

  it("stops zip bombs (declared and lying) and the API keeps serving", async () => {
    const zeros = new Uint8Array(40 * 1024 * 1024);
    const declared = buildZip([
      { name: "xl/worksheets/sheet1.xml", data: new Uint8Array(60 * 1024 * 1024) },
    ]);
    const lying = buildZip([
      { name: "xl/worksheets/sheet1.xml", data: zeros, declaredSize: 400_000 },
    ]);
    for (const bomb of [declared, lying]) {
      expect(await codes(await preview(werkNord, { file: bomb.toString("base64") }))).toEqual([
        "file_too_complex",
      ]);
    }
    expect((await preview(werkNord, { file: fixture("teilnehmer-beispiel.xlsx") })).status).toBe(
      200,
    );
  }, 60_000);
});
