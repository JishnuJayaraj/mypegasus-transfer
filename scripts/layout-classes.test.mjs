import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, violations } from "./check-layout-classes.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("a new kit class in an app file fails", () => {
  const files = [["apps/web/src/components/new-screen.tsx", fixture("new-layout-class.tsx")]];
  assert.deepEqual(check(files, []), [
    "apps/web/src/components/new-screen.tsx: names a kit class (tp-…). Layout comes from the kit's components (@transfer/ui), not from a class.",
  ]);
});

test("a style import in an app file fails", () => {
  const files = [["apps/portal/src/routes/screen.tsx", fixture("style-import.tsx")]];
  assert.deepEqual(check(files, []), [
    "apps/portal/src/routes/screen.tsx: imports a stylesheet. Styles live in packages/ui.",
  ]);
});

test("a file on the allowlist passes, and a stale entry fails so the list shrinks", () => {
  const path = "apps/web/src/components/old-screen.tsx";
  assert.deepEqual(check([[path, fixture("new-layout-class.tsx")]], [path]), []);
  assert.deepEqual(check([[path, "export const clean = 1;\n"]], [path]), [
    `${path}: no longer needs its entry in scripts/layout-allowlist.json; remove it.`,
  ]);
});

test("recognises the class in every way a className is written, and nothing else", () => {
  assert.deepEqual(violations('<div className="tp-list" />'), ["class"]);
  assert.deepEqual(violations("<div className={`tp-list ${more}`} />"), ["class"]);
  assert.deepEqual(violations("const cls = open ? 'tp-open' : undefined;"), ["class"]);
  assert.deepEqual(violations('document.querySelector(".tp-list"); // tp-list in a comment'), []);
  assert.deepEqual(violations('import { Card } from "@transfer/ui";'), []);
});
