// Existing template versions are immutable (Slice 2 plan 5.8, R22, AC-9):
//   node scripts/check-template-immutability.mjs [<base-ref>]
// Every packages/config/templates/<agenturKey>/<version>.json present at the base ref must exist
// unchanged in the working tree, compared by canonical hash, so reformatting passes. Adding a
// version passes; changing or deleting one fails. `pnpm lint` runs it; CI passes the PR's base, or
// the previous commit on main, through TEMPLATE_BASE_REF. Without a base ref it uses origin/main
// if fetched, else prints a notice and passes; under CI a missing base ref fails.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { canonicalHash } from "../packages/config/src/hash.ts";

const root = new URL("..", import.meta.url);
const templates = /^packages\/config\/templates\/[^/]+\/[^/]+\.json$/;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function exists(ref) {
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

let base = process.argv[2] || process.env.TEMPLATE_BASE_REF || undefined;
if (base === undefined && process.env.CI) {
  console.error("template immutability: no base ref (CI must pass TEMPLATE_BASE_REF)");
  process.exit(1);
}
if (base === undefined) {
  if (!exists("origin/main")) {
    console.log("template immutability: no base ref and no origin/main; not checked");
    process.exit(0);
  }
  base = "origin/main";
} else if (!exists(base)) {
  console.error(`template immutability: base ref ${base} is not a commit here (fetch it first)`);
  process.exit(1);
}

const problems = [];
const files = git("ls-tree", "-r", "--name-only", base, "--", "packages/config/templates");
for (const path of files.split("\n").filter((line) => templates.test(line))) {
  const file = new URL(path, root);
  if (!existsSync(file)) {
    problems.push(`${path}: deleted`);
    continue;
  }
  let current;
  try {
    current = canonicalHash(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    problems.push(`${path}: changed (not valid JSON)`);
    continue;
  }
  if (current !== canonicalHash(JSON.parse(git("show", `${base}:${path}`)))) {
    problems.push(`${path}: changed`);
  }
}

if (problems.length > 0) {
  console.error(`Template versions are immutable; add a new version instead (base ${base}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
