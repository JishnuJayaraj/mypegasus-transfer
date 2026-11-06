import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./locales/de.json";
import en from "./locales/en.json";

// The kit's catalogs: de and en have the same keys and every key the code names exists.

function flatten(object: object, prefix = ""): string[] {
  return Object.entries(object).flatMap(([key, value]) =>
    typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

const keys = flatten(de);
const has = (key: string) => keys.includes(key) || keys.includes(`${key}_other`);
const used = readdirSync(import.meta.dirname)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$|test-utils/.test(name))
  .flatMap((name) =>
    [...readFileSync(join(import.meta.dirname, name), "utf8").matchAll(/\bt\("([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  );

describe("ui catalogs", () => {
  it("have identical key sets in de and en", () => {
    expect(flatten(en).toSorted()).toEqual(keys.toSorted());
  });

  it("have every key the code uses", () => {
    expect(used.length).toBeGreaterThan(15);
    expect(used.filter((key) => !has(key))).toEqual([]);
  });
});
