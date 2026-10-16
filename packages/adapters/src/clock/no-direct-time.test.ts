import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url).pathname;

// Plan 5.8: these read the time only through an injected Clock. Directories that don't exist
// yet (config, jobs) are scanned as soon as they do.
const scanned = ["packages/domain/src", "packages/config/src", "apps/api/src/jobs"];
const forbidden = /\bDate\.now\s*\(|\bnew\s+Date\s*\(/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

describe("no direct time access (AC-36)", () => {
  it("finds no Date.now() or new Date() outside the Clock", () => {
    const offenders = scanned
      .map((dir) => join(root, dir))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => [...sourceFiles(dir)])
      .filter((file) => forbidden.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("would catch both forms", () => {
    expect(forbidden.test("const t = Date.now();")).toBe(true);
    expect(forbidden.test("return new Date(x)")).toBe(true);
    expect(forbidden.test("const d: Date = clock.now();")).toBe(false);
  });
});
