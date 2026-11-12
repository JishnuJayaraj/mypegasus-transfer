// The kit is the only place a layout is defined (ui-patterns.md, principle 8): an app file may
// neither name a kit class (a string that starts with `tp-`, as a `className` does) nor import a
// stylesheet. The files that did so before the kit's second layer are listed in
// scripts/layout-allowlist.json; the list only shrinks: a screen that migrates to the kit loses
// its entry, and an entry whose file no longer needs it fails the check.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["apps/web/src", "apps/portal/src"];

const kitClass = /["'`]tp-[a-z]/;
const styleImport = /^\s*import\s[^;]*\.(?:s?css|sass|less)["']/m;

/** What a source breaks: "class" (a `tp-` class), "style" (a style import), or nothing. */
export function violations(source) {
  return [
    ...(kitClass.test(source) ? ["class"] : []),
    ...(styleImport.test(source) ? ["style"] : []),
  ];
}

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

/** The problems of a tree against an allowlist of relative paths. */
export function check(files, allowlist) {
  const allowed = new Set(allowlist);
  const problems = [];
  const found = new Set();
  for (const [path, source] of files) {
    const broken = violations(source);
    if (broken.length === 0) continue;
    found.add(path);
    if (allowed.has(path)) continue;
    problems.push(
      broken.includes("class")
        ? `${path}: names a kit class (tp-…). Layout comes from the kit's components (@transfer/ui), not from a class.`
        : `${path}: imports a stylesheet. Styles live in packages/ui.`,
    );
  }
  for (const path of allowlist) {
    if (!found.has(path)) {
      problems.push(
        `${path}: no longer needs its entry in scripts/layout-allowlist.json; remove it.`,
      );
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = roots.flatMap((dir) =>
    [...sources(join(root, dir))].map((path) => [
      relative(root, path).replaceAll("\\", "/"),
      readFileSync(path, "utf8"),
    ]),
  );
  const allowlist = JSON.parse(readFileSync(join(root, "scripts/layout-allowlist.json"), "utf8"));
  const problems = check(files, allowlist);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(
    `layout classes: ${files.length} app files checked, ${allowlist.length} on the allowlist`,
  );
}
