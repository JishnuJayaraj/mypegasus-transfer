import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImportFileError } from "./errors";
import { parseBytes } from "./parse-core";
import { parseSpreadsheet } from "./parse";
import { buildZip } from "./zip-builder";
import { checkZipDirectory, verifyZipSizes } from "./zip-check";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/imports/${name}`, import.meta.url)));
const text = (value: string) => new TextEncoder().encode(value);

const zeros = (megabytes: number) => new Uint8Array(megabytes * 1024 * 1024);
const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`).join("\n");
const columns = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(";");

async function code(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImportFileError);
  return (error as ImportFileError).code;
}

describe("CSV (AC-29)", () => {
  it("reads UTF-8 with the detected delimiter, with and without a byte order mark", async () => {
    const plain = await parseSpreadsheet({ bytes: fixture("teilnehmer-beispiel.csv") });
    expect(plain).toMatchObject({
      format: "csv",
      sheets: [],
      sheet: null,
      csv: { delimiter: ";", encoding: "utf-8" },
    });
    expect(plain.rows).toHaveLength(13);
    expect(plain.rows[1]![1]).toBe("Mustermann");
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      fixture("teilnehmer-beispiel.csv"),
    ]);
    expect((await parseSpreadsheet({ bytes: bom })).rows).toEqual(plain.rows);
  });

  it("falls back to Windows-1252 and says so", async () => {
    const parsed = await parseSpreadsheet({ bytes: fixture("teilnehmer-cp1252.csv") });
    expect(parsed.csv).toEqual({ delimiter: ";", encoding: "windows-1252" });
    expect(parsed.rows[1]![1]).toBe("Müstermann");
    expect(parsed.rows[4]).toContain("Heinrichstraße 5");
  });

  it.each([
    [",", "a,b,c\n1,2,3\n"],
    ["\t", "a\tb\tc\n1\t2\t3\n"],
    [";", "a;b;c\n1;2;3\n"],
    [";", "nur eine Spalte\nzwei\n"],
  ] as const)("detects %j", async (delimiter, content) => {
    const parsed = await parseBytes({ bytes: text(content) });
    expect(parsed.csv?.delimiter).toBe(delimiter);
  });

  it("detects the delimiter below title rows, and honours an override", async () => {
    const content = "Export vom heute\n\na,b,c\n1,2,3\n";
    expect((await parseBytes({ bytes: text(content) })).rows[2]).toEqual(["a", "b", "c"]);
    const overridden = await parseBytes({ bytes: text("a;b,c\n"), csv: { delimiter: "," } });
    expect(overridden.rows[0]).toEqual(["a;b", "c"]);
  });

  it("honours an encoding override and refuses invalid UTF-8 when it is forced", async () => {
    const latin = Buffer.from("Name\nJürgen\n", "latin1");
    expect((await parseBytes({ bytes: latin, csv: { encoding: "windows-1252" } })).rows[1]).toEqual(
      ["Jürgen"],
    );
    expect(await code(parseBytes({ bytes: latin, csv: { encoding: "utf-8" } }))).toBe(
      "encoding_invalid",
    );
  });

  it("keeps quoted delimiters and drops trailing empty cells and rows", async () => {
    const parsed = await parseBytes({ bytes: text('a;b;\n"x;y";2;\n;;\n\n') });
    expect(parsed.rows).toEqual([
      ["a", "b"],
      ["x;y", "2"],
    ]);
  });

  it("refuses empty, binary and malformed files with codes", async () => {
    expect(await code(parseBytes({ bytes: new Uint8Array() }))).toBe("file_empty");
    expect(await code(parseBytes({ bytes: text(";;\n\n") }))).toBe("file_empty");
    expect(await code(parseBytes({ bytes: Uint8Array.from([0x89, 0x50, 0x00, 0x47]) }))).toBe(
      "unsupported_file",
    );
    expect(await code(parseBytes({ bytes: text('a;b\n"unclosed;1\n') }))).toBe("csv_malformed");
  });
});

describe("limits (AC-28)", () => {
  it("accepts the limits and refuses one more", async () => {
    expect((await parseBytes({ bytes: text(rows(5020)) })).rows).toHaveLength(5020);
    expect(await code(parseBytes({ bytes: text(rows(5021)) }))).toBe("too_many_rows");
    expect((await parseBytes({ bytes: text(columns(50)) })).rows[0]).toHaveLength(50);
    expect(await code(parseBytes({ bytes: text(columns(51)) }))).toBe("too_many_columns");
    expect((await parseBytes({ bytes: text("x".repeat(500)) })).rows).toHaveLength(1);
    expect(await code(parseBytes({ bytes: text("x".repeat(501)) }))).toBe("cell_too_long");
    // Characters, not UTF-16 units: 500 astral characters fit.
    expect((await parseBytes({ bytes: text("😀".repeat(500)) })).rows).toHaveLength(1);
  });
});

describe("XLSX (AC-29, AC-46)", () => {
  it("parses to the CSV fixture's content", async () => {
    const xlsx = await parseSpreadsheet({ bytes: fixture("teilnehmer-beispiel.xlsx") });
    const csv = await parseSpreadsheet({ bytes: fixture("teilnehmer-beispiel.csv") });
    expect(xlsx).toMatchObject({ format: "xlsx", sheets: ["Teilnehmende"], sheet: "Teilnehmende" });
    expect(xlsx.csv).toBeNull();
    expect(xlsx.rows).toEqual(csv.rows);
  });

  it("lists every sheet, chooses one, and marks number and date cells", async () => {
    const bytes = fixture("teilnehmer-gemischt.xlsx");
    const first = await parseSpreadsheet({ bytes });
    expect(first).toMatchObject({ sheets: ["Info", "Teilnehmende"], sheet: "Info" });
    expect(first.rows).toEqual([["Beispieldatei, nur synthetische Daten"]]);
    const parsed = await parseSpreadsheet({ bytes, sheet: "Teilnehmende" });
    // Two title rows (one empty) above the header on row 3.
    expect(parsed.rows[0]).toEqual(["Export Beispiel GmbH (synthetisch)"]);
    expect(parsed.rows[1]).toEqual([]);
    expect(parsed.rows[2]![0]).toBe("Personalnummer");
    expect(parsed.rows[3]![0]).toBe("BSP-0001");
    expect(parsed.rows[3]![3]).toEqual({ date: "1965-01-01" });
    expect(parsed.rows[4]![0]).toEqual({ number: "4711" });
    expect(parsed.rows[5]![6]).toEqual({ number: "99999" });
    expect(parsed.rows[6]![6]).toEqual({ number: "1234" });
    expect(parsed.rows[6]![9]).toEqual({ number: "301234567" });
    expect(parsed.rows[7]![3]).toEqual({ date: "1975-05-05", time: true });
  });

  it("refuses an unknown sheet", async () => {
    const bytes = fixture("teilnehmer-gemischt.xlsx");
    expect(await code(parseSpreadsheet({ bytes, sheet: "Gibt es nicht" }))).toBe("sheet_not_found");
  });

  it("refuses a zip that is no workbook", async () => {
    const bytes = buildZip([{ name: "hello.txt", data: text("hello") }]);
    expect(await code(parseSpreadsheet({ bytes }))).toBe("unsupported_file");
  });
});

describe("the ZIP central-directory check and the worker (spike S1, AC-28)", () => {
  it("accepts an ordinary workbook", () => {
    expect(checkZipDirectory(fixture("teilnehmer-gemischt.xlsx")).length).toBeGreaterThan(3);
  });

  it("refuses declared sizes beyond the limits before expanding anything", async () => {
    // 60 MB of zeros deflate to about 60 kB: the ratio and the declared total are refused.
    const bomb = buildZip([{ name: "xl/worksheets/sheet1.xml", data: zeros(60) }]);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(() => checkZipDirectory(bomb)).toThrow(ImportFileError);
    expect(await code(parseSpreadsheet({ bytes: bomb }))).toBe("file_too_complex");
    // A ratio above 100 with a small total is refused too.
    const dense = buildZip([{ name: "a.xml", data: zeros(2) }]);
    expect(() => checkZipDirectory(dense)).toThrow(ImportFileError);
  });

  it("stops a zip whose directory lies about the size, in the worker, and the API keeps serving", async () => {
    // 40 MB of zeros really, one kilobyte declared (ratio fine, total fine).
    const compressed = buildZip([{ name: "a.xml", data: zeros(40), declaredSize: 4000 }]);
    const ratioOk = buildZip([{ name: "a.xml", data: zeros(40), declaredSize: 400_000 }]);
    for (const bomb of [compressed, ratioOk]) {
      expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
      const started = Date.now();
      // The directory check passes (the declared sizes are small); the expansion up to the
      // declared size does not.
      const entries = checkZipDirectory(bomb);
      expect(() => verifyZipSizes(bomb, entries)).toThrow(ImportFileError);
      expect(await code(parseSpreadsheet({ bytes: bomb }))).toBe("file_too_complex");
      expect(Date.now() - started).toBeLessThan(10_000);
    }
    // The process is fine: the next file parses.
    expect(
      (await parseSpreadsheet({ bytes: fixture("teilnehmer-beispiel.xlsx") })).rows,
    ).toHaveLength(13);
  }, 30_000);

  it("refuses encrypted entries, duplicate names, other methods and a size that doesn't match", () => {
    const data = text("<x/>");
    expect(() => checkZipDirectory(buildZip([{ name: "a", data, flags: 1 }]))).toThrow(
      ImportFileError,
    );
    expect(() =>
      checkZipDirectory(
        buildZip([
          { name: "a", data },
          { name: "a", data },
        ]),
      ),
    ).toThrow(ImportFileError);
    const stored = buildZip([{ name: "a", data, method: 0, declaredSize: 99 }]);
    expect(() => checkZipDirectory(stored)).toThrow(ImportFileError);
    const honest = buildZip([{ name: "a", data }]);
    expect(() => verifyZipSizes(honest, checkZipDirectory(honest))).not.toThrow();
    const wrong = buildZip([{ name: "a", data, declaredSize: 2 }]);
    expect(() => verifyZipSizes(wrong, checkZipDirectory(wrong))).toThrow(ImportFileError);
    expect(() => checkZipDirectory(Buffer.from("PK\x03\x04 not a zip"))).toThrow(ImportFileError);
  });
});
