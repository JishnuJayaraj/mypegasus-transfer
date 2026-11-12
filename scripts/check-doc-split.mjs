// Proves that a split of documents moved their text and changed none of it (agent-workflow.md,
// one current statement per rule):
//   node scripts/check-doc-split.mjs [--ref <git-ref>] --before <file>... --after <file|dir>...
// Every sentence of the `--before` documents must occur in the `--after` files exactly as often
// as before, and the `--after` files must hold no other sentence. Headings, link targets and
// lines holding only links are ignored (scripts/docs-lib.mjs, sentencesOf), so headings may be
// added, links may point elsewhere and an index may list links.
// `--ref` reads the `--before` files from that commit instead of the working tree, so the check
// runs after the old files were replaced: `--ref origin/main`.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareSentences, markdownFiles } from "./docs-lib.mjs";

const args = process.argv.slice(2);
const options = { ref: null, before: [], after: [] };
let list = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--ref") options.ref = args[(index += 1)];
  else if (arg === "--before" || arg === "--after") list = options[arg.slice(2)];
  else if (list !== null) list.push(arg);
  else usage();
}
if (options.before.length === 0 || options.after.length === 0) usage();

function usage() {
  console.error(
    "usage: node scripts/check-doc-split.mjs [--ref <git-ref>] --before <file>... --after <file|dir>...",
  );
  process.exit(2);
}

const readBefore = (path) =>
  options.ref === null
    ? readFileSync(path, "utf8")
    : execFileSync("git", ["show", `${options.ref}:${path}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
const afterFiles = options.after.flatMap((path) =>
  statSync(path).isDirectory() ? markdownFiles(path).map((file) => join(path, file)) : [path],
);

const result = compareSentences(
  options.before.map(readBefore),
  afterFiles.map((path) => readFileSync(path, "utf8")),
);

const from = options.ref === null ? "" : ` at ${options.ref}`;
console.log(
  `${options.before.length} documents${from}: ${result.before} sentences; ` +
    `${afterFiles.length} files now: ${result.after} sentences.`,
);
const show = (label, entries) => {
  if (entries.length === 0) return;
  console.error(`${label} (${entries.length}):`);
  for (const { sentence, before, after } of entries.slice(0, 40)) {
    console.error(`  ${before} → ${after}  ${sentence.slice(0, 160)}`);
  }
  if (entries.length > 40) console.error(`  … and ${entries.length - 40} more`);
};
show("Missing or found less often than before", result.missing);
show("New or found more often than before", result.extra);
if (result.missing.length > 0 || result.extra.length > 0) process.exit(1);
console.log(
  "Every sentence is in the new files exactly as often as before, and nothing was added.",
);
