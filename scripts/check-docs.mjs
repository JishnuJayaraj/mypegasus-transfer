// The docs stay navigable and small enough to read whole (agent-workflow.md, one current
// statement per rule):
//   node scripts/check-docs.mjs [<root>]
// Fails on
// - a relative link in a Markdown file whose target file or directory doesn't exist, or whose
//   `#anchor` is no heading of the target document;
// - a Markdown file over 40 KB (40,000 bytes), so a topic is split before it becomes a build
//   log. Excepted: generated files, `docs/open-questions.md` (one table, read by row), the
//   archived plans (history, not read) and the files listed in `oversized` below, which were
//   larger when the check was introduced and may not grow;
// - a question number that has no row, or more than one, across `docs/open-questions.md`,
//   `docs/decisions/settled-questions.md` and `docs/decisions/readings.md`: a row's number is the
//   bare number in its first cell, and a number between 1 and the highest must be in exactly one
//   of the three unless `unassignedQuestions` names it.
// `pnpm lint` runs it on the repository; the tests run it on fixtures.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { headingsOf, linksOf, markdownFiles } from "./docs-lib.mjs";

export const maxBytes = 40_000;

/** Files without a size limit: generated, read by row, or history. */
const unlimited = [
  /^docs\/domain\/generated\//,
  /^docs\/open-questions\.md$/,
  /^docs\/plans\/archive\//,
];

/**
 * Files that were over the limit when the check was introduced (docs/open-questions.md, Q259).
 * Each may shrink but not grow past the size recorded here; remove the entry once it is split.
 */
const oversized = new Map([
  ["docs/adr/0010-api-contract.md", 69_631],
  ["docs/plans/slice-7.md", 70_180],
]);

const questionFiles = [
  "docs/open-questions.md",
  "docs/decisions/settled-questions.md",
  "docs/decisions/readings.md",
];

/**
 * Numbers that never had a row of their own, or whose row is not in the three files yet:
 * Q241–Q253 are reserved for the Slice 8 plan (plans/archive/slice-7b.md, status).
 */
const unassignedQuestions = new Set(Array.from({ length: 13 }, (_, index) => 241 + index));

export function checkDocs(root, { known = unassignedQuestions, ceilings = oversized } = {}) {
  const problems = [];
  const files = markdownFiles(root);
  const read = (file) => readFileSync(join(root, file), "utf8");
  const anchors = new Map();
  const anchorsOf = (file) => {
    if (!anchors.has(file)) anchors.set(file, new Set(headingsOf(read(file)).map((h) => h.slug)));
    return anchors.get(file);
  };

  for (const file of files) {
    const text = read(file);

    for (const { target, line } of linksOf(text)) {
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const [path, anchor] = target.split("#");
      const decoded = decodeURIComponent(path);
      const destination = path === "" ? file : normalize(join(dirname(file), decoded));
      if (destination.startsWith("..")) continue; // outside the repository: not ours to check
      if (!existsSync(join(root, destination))) {
        problems.push(`${file}:${line}: broken link ${target} (no ${destination})`);
      } else if (
        anchor !== undefined &&
        anchor !== "" &&
        destination.endsWith(".md") &&
        !anchorsOf(destination).has(decodeURIComponent(anchor).toLowerCase())
      ) {
        problems.push(`${file}:${line}: broken link ${target} (no heading #${anchor})`);
      }
    }

    const bytes = statSync(join(root, file)).size;
    const limit = ceilings.get(file) ?? maxBytes;
    if (bytes > limit && !unlimited.some((pattern) => pattern.test(file))) {
      problems.push(
        ceilings.has(file)
          ? `${file}: ${bytes} bytes, more than the ${limit} it had when the 40 KB limit came; split it instead of adding to it`
          : `${file}: ${bytes} bytes, over the limit of ${maxBytes} (40 KB); split it by topic`,
      );
    }
  }

  const present = questionFiles.filter((file) => existsSync(join(root, file)));
  if (present.length > 0) {
    const rows = new Map();
    for (const file of present) {
      for (const line of read(file).split("\n")) {
        const number = /^\|\s*(\d+)\s*\|/.exec(line)?.[1];
        if (number === undefined) continue;
        rows.set(Number(number), [...(rows.get(Number(number)) ?? []), file]);
      }
    }
    const highest = Math.max(0, ...rows.keys(), ...known);
    for (let number = 1; number <= highest; number += 1) {
      const found = rows.get(number) ?? [];
      if (found.length === 0 && !known.has(number)) {
        problems.push(`Q${number}: no row in ${questionFiles.join(", ")}`);
      } else if (found.length > 1) {
        problems.push(
          `Q${number}: ${found.length} rows (${found.join(", ")}); a number has one row`,
        );
      } else if (found.length === 1 && known.has(number)) {
        problems.push(
          `Q${number}: has a row now; remove it from unassignedQuestions in scripts/check-docs.mjs`,
        );
      }
    }
  }

  return { files: files.length, problems };
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1])
) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  const { files, problems } = checkDocs(root);
  if (problems.length > 0) {
    console.error(`The docs check failed (${relative(process.cwd(), root) || "."}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Docs: ${files} Markdown files, links, sizes and question numbers checked.`);
}
