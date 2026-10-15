import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";

// AC-20: the de and en catalogs have the same keys, and every key the code uses exists.

function flatten(object: object, prefix = ""): string[] {
  return Object.entries(object).flatMap(([key, value]) =>
    typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const values = (catalog: object): unknown[] =>
  Object.values(catalog).flatMap((v) => (typeof v === "object" ? values(v) : [v]));

const used = sourceFiles(import.meta.dirname).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]!),
);

describe("portal catalogs", () => {
  it("have identical key sets in de and en", () => {
    expect(flatten(en).toSorted()).toEqual(flatten(de).toSorted());
  });

  it("have every key the code uses", () => {
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((key) => !flatten(de).includes(key))).toEqual([]);
  });

  it("have no empty texts", () => {
    expect(values(de).filter((v) => v === "")).toEqual([]);
    expect(values(en).filter((v) => v === "")).toEqual([]);
  });
});
