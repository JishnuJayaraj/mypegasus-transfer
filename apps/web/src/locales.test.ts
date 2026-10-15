import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./locales/de/translation.json";

// AC-20: every key the code uses exists in the de catalog. Template-literal keys are checked by
// the typed keys (i18next.d.ts) at typecheck time; this test covers the plain string keys.

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

const keys = new Set(flatten(de));
const used = sourceFiles(import.meta.dirname).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/\bt\("([^"]+)"\)/g)].map((match) => match[1]!),
);

describe("de catalog", () => {
  it("finds the keys used in the code", () => {
    expect(used.length).toBeGreaterThan(10);
  });

  it("has every key the code uses", () => {
    expect(used.filter((key) => !keys.has(key))).toEqual([]);
  });

  it("has no empty texts", () => {
    const empty = flatten(de).filter((key) => {
      const value = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], de);
      return value === "";
    });
    expect(empty).toEqual([]);
  });
});
