// Tests of the docs checks (`node --test scripts/`, part of `pnpm lint`): each failure the checks
// exist for is shown on a small fixture written to a temporary directory.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocs, maxBytes } from "./check-docs.mjs";
import { compareSentences, headingsOf, sentencesOf } from "./docs-lib.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const problemsOf = (files, options = { known: new Set(), ceilings: new Map() }) =>
  checkDocs(fixture(files), options).problems;

const original = [
  "# Lifecycle",
  "",
  "> Status: updated. Items marked *(provisional)* rest on assumed answers.",
  "",
  "## Dates",
  "",
  "- Legal dates are stored as `date`. Deadlines are",
  "  **inclusive**: expiry happens the following day (see [Rules](#rules)).",
  "- A wave is a timing cohort.",
  "",
  "| Kind | Date |",
  "|---|---|",
  "| `tg_start` | the effective TG start |",
  "",
  "## Rules",
  "",
  "```",
  "informed --> active_in_tg",
  "```",
  "",
  "Every change is audited. See [the ADR](../adr/0002.md).",
  "",
].join("\n");

const index = [
  "# Lifecycle",
  "",
  "## [Dates](lifecycle/dates.md#dates)",
  "",
  "## [Rules](lifecycle/rules.md#rules)",
  "",
].join("\n");
const status = "> Status: updated. Items marked *(provisional)* rest on assumed answers.\n";
const dates = [
  "# Lifecycle: dates",
  "",
  "## Dates",
  "",
  "- Legal dates are stored as `date`. Deadlines are",
  "  **inclusive**: expiry happens the following day (see [Rules](rules.md#rules)).",
  "- A wave is a timing cohort.",
  "",
  "| Kind | Date |",
  "|---|---|",
  "| `tg_start` | the effective TG start |",
  "",
].join("\n");
const rules = [
  "# Lifecycle: rules",
  "",
  "## Rules",
  "",
  "```",
  "informed --> active_in_tg",
  "```",
  "",
  "Every change is audited. See [the ADR](../../adr/0002.md).",
  "",
].join("\n");

test("a split that moves every sentence once passes, whatever its headings and link targets", () => {
  const result = compareSentences(
    [original],
    [index + "\n- [Dates](lifecycle/dates.md)\n", status, dates, rules],
  );
  assert.deepEqual([result.missing, result.extra], [[], []]);
  assert.equal(result.before, result.after);
});

test("a document compared with itself passes", () => {
  const result = compareSentences([original], [original]);
  assert.deepEqual([result.missing, result.extra], [[], []]);
});

test("a dropped sentence fails", () => {
  const result = compareSentences(
    [original],
    [index, status, dates.replace("- A wave is a timing cohort.\n", ""), rules],
  );
  assert.deepEqual(result.missing, [
    { sentence: "- A wave is a timing cohort.", before: 1, after: 0 },
  ]);
});

test("a duplicated sentence fails", () => {
  const result = compareSentences(
    [original],
    [index, status, dates, rules + "\nEvery change is audited.\n"],
  );
  assert.deepEqual(result.extra, [{ sentence: "Every change is audited.", before: 1, after: 2 }]);
});

test("a reworded sentence and a changed code line fail", () => {
  const reworded = compareSentences(
    [original],
    [index, status, dates.replace("timing cohort", "cohort"), rules],
  );
  assert.equal(reworded.missing.length, 1);
  assert.equal(reworded.extra.length, 1);
  const code = compareSentences([original], [index, status, dates, rules.replace("-->", "->")]);
  assert.deepEqual(
    code.missing.map((entry) => entry.sentence),
    ["informed --> active_in_tg"],
  );
});

test("a sentence added to the new files fails", () => {
  const result = compareSentences(
    [original],
    [index + "\nThe text moved to the topic files.\n", status, dates, rules],
  );
  assert.deepEqual(
    result.extra.map((entry) => entry.sentence),
    ["The text moved to the topic files."],
  );
});

test("a repeated row must be repeated as often", () => {
  assert.deepEqual(
    sentencesOf("| a |\n|---|\n\n| b |\n|---|\n").filter((row) => row === "|---|").length,
    2,
  );
  const result = compareSentences(
    ["| a |\n|---|\n\n| b |\n|---|\n"],
    ["| a |\n|---|\n", "| b |\n"],
  );
  assert.deepEqual(result.missing, [{ sentence: "|---|", before: 2, after: 1 }]);
});

test("the comparison script exits 0 on a no-op and 1 on a dropped sentence", () => {
  const root = fixture({
    "before.md": original,
    "same/a.md": original,
    "less/a.md": original.replace("Every change is audited. ", ""),
  });
  const run = (after) =>
    spawnSync(
      process.execPath,
      [
        join(scripts, "check-doc-split.mjs"),
        "--before",
        join(root, "before.md"),
        "--after",
        join(root, after),
      ],
      { encoding: "utf8" },
    );
  assert.equal(run("same").status, 0);
  const less = run("less");
  assert.equal(less.status, 1);
  assert.match(less.stderr, /1 → 0 {2}Every change is audited\./);
});

test("heading anchors follow GitHub: formatting dropped, duplicates numbered, a linked heading keeps its anchor", () => {
  const slugs = headingsOf(
    [
      "## Two Agenturen *(provisional, Q15)*",
      "## TG entry guard (`informed → active_in_tg`)",
      "## [Dates](lifecycle/dates.md#dates)",
      "## Dates",
      "```",
      "## not a heading",
      "```",
    ].join("\n"),
  ).map((heading) => heading.slug);
  assert.deepEqual(slugs, [
    "two-agenturen-provisional-q15",
    "tg-entry-guard-informed--active_in_tg",
    "dates",
    "dates-1",
  ]);
});

test("the docs check passes on linked, small documents", () => {
  assert.deepEqual(
    problemsOf({
      "docs/index.md":
        "# Index\n\n## [Dates](topic/dates.md#dates)\n\n[the folder](topic/) and [the site](https://example.org/x.md)\n",
      "docs/topic/dates.md":
        "# Dates\n\n## Dates\n\nBack to [the index](../index.md#dates), see `[not a link](missing.md)`.\n",
    }),
    [],
  );
});

test("a broken relative link fails: a missing file and a missing heading", () => {
  assert.deepEqual(
    problemsOf({
      "docs/index.md":
        "# Index\n\nSee [dates](topic/dates.md) and\n[rules](topic/dates.md#rules).\n",
      "docs/topic/dates.md": "# Dates\n\nSee [the index](index.md).\n",
    }),
    [
      "docs/index.md:4: broken link topic/dates.md#rules (no heading #rules)",
      "docs/topic/dates.md:3: broken link index.md (no docs/topic/index.md)",
    ],
  );
});

test("a document over 40 KB fails; generated files, open-questions.md and archived plans don't", () => {
  const large = `# Large\n\n${"x".repeat(maxBytes)}\n`;
  assert.deepEqual(
    problemsOf({
      "docs/domain/topic.md": large,
      "docs/domain/fits.md": "x".repeat(maxBytes),
      "docs/domain/generated/access-matrix.md": large,
      "docs/open-questions.md": large,
      "docs/plans/archive/slice-1.md": large,
    }),
    [
      `docs/domain/topic.md: ${large.length} bytes, over the limit of 40000 (40 KB); split it by topic`,
    ],
  );
});

test("a document that was over the limit may shrink but not grow", () => {
  const files = { "docs/adr/0010.md": "x".repeat(50_000) };
  assert.deepEqual(
    problemsOf(files, { known: new Set(), ceilings: new Map([["docs/adr/0010.md", 50_000]]) }),
    [],
  );
  assert.equal(
    problemsOf(files, { known: new Set(), ceilings: new Map([["docs/adr/0010.md", 49_999]]) })
      .length,
    1,
  );
});

test("every question number has exactly one row across the three files", () => {
  const head = "| # | Topic |\n|---|---|\n";
  const files = {
    "docs/open-questions.md": `${head}| 1 | open |\n| 3 | split, the open part |\n`,
    "docs/decisions/settled-questions.md": `${head}| 2 | settled |\n`,
    "docs/decisions/readings.md": `${head}| 4 | built |\n\n| From | History |\n|---|---|\n| Q3 | the history of a split row |\n`,
  };
  assert.deepEqual(problemsOf(files), []);
  assert.deepEqual(
    problemsOf({ ...files, "docs/decisions/readings.md": `${head}| 1 | built |\n| 5 | built |\n` }),
    [
      "Q1: 2 rows (docs/open-questions.md, docs/decisions/readings.md); a number has one row",
      "Q4: no row in docs/open-questions.md, docs/decisions/settled-questions.md, docs/decisions/readings.md",
    ],
  );
  assert.deepEqual(
    problemsOf(
      { ...files, "docs/decisions/readings.md": head },
      { known: new Set([4]), ceilings: new Map() },
    ),
    [],
  );
});

test("the repository's docs pass", () => {
  execFileSync(process.execPath, [join(scripts, "check-docs.mjs")], { stdio: "pipe" });
});
