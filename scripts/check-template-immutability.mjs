// Merged versions are immutable (regional-variation.md, template versions; ADR-0009):
//   node scripts/check-template-immutability.mjs [<base-ref>]
// Every file below present at the base ref must exist unchanged in the working tree:
// - the Agentur templates `packages/config/templates/<agenturKey>/<version>.json`, compared by
//   canonical hash, so reformatting passes;
// - each official form version's `blank.pdf` (by bytes) and `source.json` (canonical), and the
//   identity in its `manifest.json` (`formCode`, `version`, `sha256`; the effective dates are set
//   once reviewed, so they may change);
// - each own template version's files `packages/forms/templates/own/<name>/v<n>/*` (by bytes).
// Adding a version passes; changing or deleting one fails. `pnpm lint` runs it; CI passes the
// PR's base, or the previous commit on main, through TEMPLATE_BASE_REF. Without a base ref it uses
// origin/main if fetched, else prints a notice and passes; under CI a missing base ref fails.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { canonicalHash } from "../packages/config/src/hash.ts";

const root = new URL("..", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const gitBytes = (...args) => execFileSync("git", args, { cwd: root });

const bytes = (content) => createHash("sha256").update(content).digest("hex");
const canonical = (content) => canonicalHash(JSON.parse(content.toString("utf8")));
const formIdentity = (content) => {
  const { formCode, version, sha256 } = JSON.parse(content.toString("utf8"));
  return canonicalHash({ formCode, version, sha256 });
};

const rules = [
  { pattern: /^packages\/config\/templates\/[^/]+\/[^/]+\.json$/, hash: canonical },
  { pattern: /^packages\/forms\/templates\/ba\/[^/]+\/[^/]+\/blank\.pdf$/, hash: bytes },
  { pattern: /^packages\/forms\/templates\/ba\/[^/]+\/[^/]+\/source\.json$/, hash: canonical },
  { pattern: /^packages\/forms\/templates\/ba\/[^/]+\/[^/]+\/manifest\.json$/, hash: formIdentity },
  { pattern: /^packages\/forms\/templates\/own\/[^/]+\/v[0-9]+\/[^/]+$/, hash: bytes },
];

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
const files = git(
  "ls-tree",
  "-r",
  "--name-only",
  base,
  "--",
  "packages/config/templates",
  "packages/forms/templates",
);
for (const path of files.split("\n")) {
  const rule = rules.find(({ pattern }) => pattern.test(path));
  if (!rule) continue;
  const file = new URL(path, root);
  if (!existsSync(file)) {
    problems.push(`${path}: deleted`);
    continue;
  }
  let current;
  try {
    current = rule.hash(readFileSync(file));
  } catch {
    problems.push(`${path}: changed (not valid JSON)`);
    continue;
  }
  if (current !== rule.hash(gitBytes("show", `${base}:${path}`))) {
    problems.push(`${path}: changed`);
  }
}

if (problems.length > 0) {
  console.error(
    `Template and form versions are immutable; add a new version instead (base ${base}):`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
